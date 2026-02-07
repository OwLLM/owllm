"""
Environment Registry - Bridges EnvironmentManager and LLM Server System
Provides environment specifications with validated Python paths for each model.

PHASE 2 REFACTOR: Uses env_key for shared environments instead of per-model envs.
"""
from dataclasses import dataclass
from pathlib import Path
import sys
import json
from typing import Optional
import subprocess
import os
import uuid
import shutil


@dataclass
class EnvSpec:
    """Environment specification with validated python executable"""
    key: str  # Environment key (e.g., "torch-cu121-transformers-bnb")
    python_executable: Path  # Path to python.exe in the environment (validated)
    metadata: dict  # Environment metadata from EnvironmentManager


class EnvRegistry:
    """
    Registry for managing shared Python environments by env_key.
    PHASE 2: Replaces per-model envs with shared env_key-based envs.
    """
    
    def __init__(self):
        from core.environment_manager import EnvironmentManager
        from core.envs.env_key_resolver import EnvKeyResolver
        from core.state_store import get_state_store
        
        self.env_manager = EnvironmentManager()
        self.env_key_resolver = EnvKeyResolver()
        self.state_store = get_state_store()
        
        # PHASE 2: Shared environments directory (.envs/ instead of environments/)
        self.envs_dir = self.env_manager.root_dir / ".envs"
        self.envs_dir.mkdir(exist_ok=True)
        
        # Constraints directory for reproducible builds
        self.constraints_dir = self.env_manager.root_dir / "constraints"
        self.constraints_dir.mkdir(exist_ok=True)
        
        # Windows subprocess flags to prevent CMD window flashing
        self.subprocess_flags = {}
        if sys.platform == 'win32':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            self.subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }

    def _get_env_python_executable(self, env_key: str) -> Optional[Path]:
        """Get Python executable path for env_key"""
        env_path = self.envs_dir / env_key / ".venv"
        if sys.platform == 'win32':
            python_exe = env_path / "Scripts" / "python.exe"
        else:
            python_exe = env_path / "bin" / "python"
        return python_exe if python_exe.exists() else None

    def _get_env_pip_executable(self, python_exe: Path) -> Optional[Path]:
        """Get pip executable path for a given env python"""
        if sys.platform == 'win32':
            pip_exe = python_exe.parent / "pip.exe"
        else:
            pip_exe = python_exe.parent / "pip"
        return pip_exe if pip_exe.exists() else None

    def _get_active_profile_data(self) -> Optional[dict]:
        """Get active hardware profile data (delegates to resolver)"""
        return self.env_key_resolver.get_active_profile_data()

    def _get_base_python_for_env(self, env_key: str, required_packages: Optional[list] = None, log_callback=None) -> Optional[Path]:
        """
        Single source of truth for base Python when creating envs.
        GPTQ needs Python 3.11 (cp311) for auto-gptq wheels; otherwise use default.
        """
        def log(msg: str):
            if log_callback:
                log_callback(msg)
            import logging
            logging.info(msg)

        required_packages = required_packages or []
        needs_gptq = any(p and "auto-gptq" in str(p).lower() for p in required_packages)
        if not needs_gptq:
            return None

        root_dir = self.env_manager.root_dir
        try:
            from core.python_runtime import PythonRuntimeManager
            mgr = PythonRuntimeManager(root_dir)
            py311 = mgr.get_python_runtime("3.11")
            if py311 and py311.exists():
                log(f"Using bundled Python 3.11 for GPTQ env: {py311}")
                return py311
        except Exception as e:
            log(f"[WARN] Could not get bundled Python 3.11 for GPTQ: {e}")
        return None

    def _find_windows_python(self, version: str, log_callback=None) -> Optional[Path]:
        """
        Try to locate a specific Python version on Windows via the py launcher.
        Returns python.exe path or None.
        """
        if sys.platform != "win32":
            return None

        def log(msg: str):
            if log_callback:
                log_callback(msg)
            import logging
            logging.info(msg)

        try:
            r = subprocess.run(
                ["py", f"-{version}", "-c", "import sys; print(sys.executable)"],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags,
            )
            if r.returncode != 0:
                return None
            exe = (r.stdout or "").strip().splitlines()[-1].strip()
            p = Path(exe)
            if p.exists():
                return p
        except Exception as e:
            log(f"[WARN] Could not resolve Python {version} via py launcher: {e}")
        return None
    
    def _atomic_create_env(
        self,
        env_key: str,
        profile_data: dict,
        log_callback=None,
        base_python_exe: Optional[Path] = None,
    ) -> Path:
        """
        PHASE 2: Atomically create environment with health checks.
        Creates in .tmp/<env_key>-<uuid>, validates, then renames to final location.
        
        Args:
            env_key: Environment key
            profile_data: Hardware profile data
            log_callback: Optional log callback
        
        Returns:
            Path to final env directory
        
        Raises:
            RuntimeError: If creation or validation fails
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
            import logging
            logging.info(msg)
        
        debug_dump_written = False

        # Create unique temp directory
        tmp_id = str(uuid.uuid4())[:8]
        tmp_dir = self.envs_dir / ".tmp" / f"{env_key}-{tmp_id}"
        tmp_dir.parent.mkdir(exist_ok=True)
        
        final_dir = self.envs_dir / env_key
        
        # Mark as CREATING in StateStore
        self.state_store.upsert_env(
            env_key=env_key,
            status="CREATING"
        )
        
        try:
            log(f"Creating environment in temp location: {tmp_dir}")
            
            # Create venv (optionally using a specific base Python)
            venv_path = tmp_dir / ".venv"
            creator_python = base_python_exe or Path(sys.executable)
            if base_python_exe:
                log(f"Using base Python for venv creation: {creator_python}")
            # NOTE: Python embeddable distributions can lack stdlib `venv` on Windows.
            # Fall back to `virtualenv` for self-contained isolated environments.
            create_cmd = [str(creator_python), "-m", "venv", str(venv_path), "--clear"]
            try:
                probe = subprocess.run(
                    [str(creator_python), "-c", "import venv; print('OK')"],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    **self.subprocess_flags
                )
                has_venv = probe.returncode == 0 and "OK" in (probe.stdout or "")
            except Exception:
                has_venv = False

            if not has_venv:
                log("Base Python lacks stdlib venv; using virtualenv to create isolated environment.")
                # Best-effort: ensure virtualenv is installed in the creator runtime
                try:
                    subprocess.run(
                        [str(creator_python), "-m", "pip", "install", "--upgrade", "virtualenv", "-q"],
                        capture_output=True,
                        text=True,
                        timeout=300,
                        **self.subprocess_flags
                    )
                except Exception:
                    pass
                create_cmd = [str(creator_python), "-m", "virtualenv", str(venv_path), "--clear"]

            result = subprocess.run(
                create_cmd,
                capture_output=True,
                text=True,
                timeout=120,
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                err = (result.stderr or result.stdout or "").strip()
                raise RuntimeError(f"Failed to create venv: {err}")
            
            # Get Python executable
            if sys.platform == 'win32':
                python_exe = venv_path / "Scripts" / "python.exe"
            else:
                python_exe = venv_path / "bin" / "python"
            
            if not python_exe.exists():
                raise RuntimeError(f"Python executable not found after venv creation: {python_exe}")
            
            log(f"Virtual environment created, installing dependencies...")
            pip_exe = self._get_env_pip_executable(python_exe)
            if not pip_exe:
                raise RuntimeError(f"Pip executable not found after venv creation: {python_exe.parent}")
            
            # Install base packages
            log("Installing pip, setuptools, wheel...")
            subprocess.run(
                [str(pip_exe), "install", "--upgrade", "pip", "setuptools", "wheel", "-q"],
                capture_output=True,
                text=True,
                timeout=300,
                **self.subprocess_flags
            )
            
            # Install server framework
            log("Installing server framework...")
            subprocess.run(
                [str(pip_exe), "install",
                 "uvicorn[standard]", "fastapi", "pydantic", "pyyaml", "-q"],
                capture_output=True,
                text=True,
                timeout=300,
                **self.subprocess_flags
            )
            
            # Install torch stack
            log("Installing PyTorch stack...")
            self._ensure_profile_torch(python_exe, profile_data, log_callback=log_callback)
            
            # Install minimal inference stack
            log("Installing inference packages...")
            # Pass env_key to conditionally install bitsandbytes
            self._install_inference_stack(python_exe, profile_data, log_callback=log_callback, env_key=env_key)
            
            # Health check
            log("Running health checks...")
            health_result = self._run_env_health_check(python_exe, env_key, log_callback=log_callback)
            if health_result.returncode != 0:
                pip_info = self._collect_pip_debug_info(pip_exe)
                self._log_health_check_failure(health_result, log_callback, pip_info=pip_info)
                fix_attempted = False

                parsed = self.env_key_resolver.parse_env_key(env_key)
                accelerator = parsed.get("accelerator", "cpu")

                # Fix 1: wrong torch wheel installed in CUDA env
                if accelerator.startswith("cu"):
                    if self._health_check_indicates_cuda_mismatch(health_result):
                        log("Detected CUDA torch mismatch, reinstalling CUDA torch stack...")
                        self._ensure_profile_torch(python_exe, profile_data, log_callback=log_callback)
                        fix_attempted = True

                # Fix 2: missing core inference packages
                missing = self.check_missing_packages(
                    python_exe,
                    required_packages=["transformers", "safetensors", "tokenizers", "accelerate", "typing_extensions"]
                )
                if missing:
                    log(f"Missing core packages detected: {missing}")
                    self._install_inference_stack(
                        python_exe,
                        profile_data,
                        log_callback=log_callback,
                        env_key=env_key,
                        force_reinstall=True,
                    )
                    fix_attempted = True

                # Fix 3: server stack import failures due to old typing_extensions (pydantic_core expects Sentinel)
                combined = ((health_result.stdout or "") + "\n" + (health_result.stderr or ""))
                if ("cannot import name 'sentinel' from 'typing_extensions'" in combined.lower()) or ("no module named 'typing_extensions'" in combined.lower()):
                    log("Detected typing_extensions incompatibility; upgrading typing_extensions...")
                    try:
                        subprocess.run(
                            [str(pip_exe), "install", "--upgrade", "typing_extensions>=4.12.2,<5.0.0"],
                            capture_output=True,
                            text=True,
                            timeout=300,
                            **self.subprocess_flags
                        )
                        fix_attempted = True
                    except Exception as e:
                        log(f"Failed to upgrade typing_extensions: {e}")

                if fix_attempted:
                    log("Re-running health check after fixes...")
                    health_result = self._run_env_health_check(python_exe, env_key, log_callback=log_callback)
                    if health_result.returncode == 0:
                        log("Health check passed after fixes.")
                    else:
                        pip_info = self._collect_pip_debug_info(pip_exe)
                        self._log_health_check_failure(health_result, log_callback, pip_info=pip_info)
                        self._write_env_debug_dump(
                            tmp_dir,
                            env_key,
                            python_exe,
                            pip_exe,
                            health_result,
                            log_callback=log_callback,
                        )
                        debug_dump_written = True
                        raise RuntimeError(self._format_health_check_error(health_result, pip_info=pip_info))
                else:
                    pip_info = self._collect_pip_debug_info(pip_exe)
                    self._write_env_debug_dump(
                        tmp_dir,
                        env_key,
                        python_exe,
                        pip_exe,
                        health_result,
                        log_callback=log_callback,
                    )
                    debug_dump_written = True
                    raise RuntimeError(self._format_health_check_error(health_result, pip_info=pip_info))
            
            # Generate constraints file
            log("Generating constraints file...")
            self._generate_constraints(python_exe, env_key)
            
            # Move to final location (atomic on same filesystem)
            log(f"Moving environment to final location: {final_dir}")
            if final_dir.exists():
                # Remove old version
                log("Removing old environment...")
                self._rmtree_windows_safe(final_dir)
            
            # FIX: Use copytree instead of rename to avoid Windows MAX_PATH issues
            # This is slower but much more reliable on Windows with deep package structures
            if sys.platform == 'win32':
                log("Copying environment (Windows long path workaround)...")
                shutil.copytree(tmp_dir, final_dir, dirs_exist_ok=True)
                # Clean up temp after successful copy
                self._rmtree_windows_safe(tmp_dir)
            else:
                # On Unix, rename is atomic and fast
                tmp_dir.rename(final_dir)
            
            # Update StateStore
            torch_version, cuda_available = self._get_torch_info(self._get_env_python_executable(env_key))
            self.state_store.upsert_env(
                env_key=env_key,
                python_path=str(self._get_env_python_executable(env_key)),
                torch_version=torch_version,
                cuda_version=profile_data.get("cuda_version", "cpu"),
                backend="transformers",  # Default
                status="READY"
            )
            
            log(f"Environment {env_key} ready!")
            return final_dir
            
        except Exception as e:
            # Clean up temp dir on failure
            if tmp_dir.exists():
                try:
                    if debug_dump_written:
                        log(f"Preserving failed env directory for debugging: {tmp_dir}")
                    else:
                        self._rmtree_windows_safe(tmp_dir)
                except:
                    pass
            
            # Mark as FAILED in StateStore
            self.state_store.upsert_env(
                env_key=env_key,
                status="FAILED",
                last_error=str(e)[:500]
            )
            
            raise RuntimeError(f"Failed to create environment {env_key}: {e}")
    
    def _rmtree_windows_safe(self, path: Path):
        """
        Remove directory tree with Windows MAX_PATH workaround.
        Uses extended-length path prefix for Windows paths exceeding 260 chars.
        """
        if sys.platform == 'win32':
            # Convert to extended-length path for Windows
            # This allows paths up to 32,767 characters
            path_str = str(path.resolve())
            if not path_str.startswith('\\\\?\\'):
                if path_str.startswith('\\\\'):
                    # UNC path: \\server\share -> \\?\UNC\server\share
                    path_str = '\\\\?\\UNC\\' + path_str[2:]
                else:
                    # Regular path: C:\path -> \\?\C:\path
                    path_str = '\\\\?\\' + path_str
            
            import os
            
            # Use os.walk with extended path for deletion
            for root, dirs, files in os.walk(path_str, topdown=False):
                for name in files:
                    file_path = os.path.join(root, name)
                    try:
                        os.chmod(file_path, 0o777)
                        os.remove(file_path)
                    except Exception:
                        pass
                for name in dirs:
                    dir_path = os.path.join(root, name)
                    try:
                        os.chmod(dir_path, 0o777)
                        os.rmdir(dir_path)
                    except Exception:
                        pass
            
            # Remove root directory
            try:
                os.chmod(path_str, 0o777)
                os.rmdir(path_str)
            except Exception:
                pass
        else:
            # Unix: regular shutil.rmtree works fine
            shutil.rmtree(path)

    def _build_health_check_code(self, accelerator: str) -> str:
        """
        Build deterministic health check code string for env validation.
        """
        code = [
            "import sys",
            "print('PYTHON_EXE', sys.executable)",
            "print('PYTHON_VERSION', sys.version)",
            # Server stack: if these imports fail, the model is not truly READY (server can't start).
            "import typing_extensions",
            "print('typing_extensions_file', getattr(typing_extensions, '__file__', ''))",
            "from typing_extensions import Sentinel",
            "print('typing_extensions.Sentinel', Sentinel)",
            "import pydantic",
            "import pydantic_core",
            "import fastapi",
            "import uvicorn",
            "print('pydantic.__version__', getattr(pydantic, '__version__', ''))",
            "print('pydantic_core.__version__', getattr(pydantic_core, '__version__', ''))",
            "print('fastapi.__version__', getattr(fastapi, '__version__', ''))",
            "print('uvicorn.__version__', getattr(uvicorn, '__version__', ''))",
            "import torch",
            "import transformers",
            "print('torch.__version__', torch.__version__)",
            "print('torch.version.cuda', torch.version.cuda)",
            "print('torch.cuda.is_available()', torch.cuda.is_available())",
            "print('transformers.__version__', transformers.__version__)",
            f"accel = '{accelerator}'",
            "if accel.startswith('cu'):",
            "    if torch.version.cuda is None or not torch.cuda.is_available():",
            "        raise SystemExit('CUDA build not installed or CUDA unavailable')",
            "print('OK')",
        ]
        return "\n".join(code)

    def _run_env_health_check(self, python_exe: Path, env_key: str, log_callback=None) -> subprocess.CompletedProcess:
        """
        Run explicit health check inside the environment and return the process result.
        """
        parsed = self.env_key_resolver.parse_env_key(env_key)
        accelerator = parsed.get("accelerator", "cpu")
        code = self._build_health_check_code(accelerator)
        cmd = [str(python_exe), "-c", code]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            **self.subprocess_flags
        )
        if log_callback:
            log_callback(f"Health check command: {cmd}")
        return result
    
    def run_model_load_probe(
        self,
        python_exe: Path,
        model_path: str,
        adapter_dir: Optional[str] = None,
        log_callback=None
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """
        Probe whether the environment can actually load the model.
        Runs inside the environment to validate model architecture support.
        
        Args:
            python_exe: Python executable in the environment
            model_path: Path to base model directory
            adapter_dir: Optional adapter directory
            
        Returns:
            Tuple of (success: bool, reason_code: Optional[str], error_message: Optional[str])
            reason_code: UNSUPPORTED_ARCH | MISSING_PACKAGE | REMOTE_CODE_REQUIRED | OTHER | None
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
        
        # Build probe code that attempts to load model config and validate architecture
        # Escape paths for Python string
        model_path_escaped = str(model_path).replace("\\", "\\\\").replace('"', '\\"')
        adapter_dir_escaped = str(adapter_dir).replace("\\", "\\\\").replace('"', '\\"') if adapter_dir else None
        
        probe_code = f"""
import sys
import json
from pathlib import Path

model_path = Path(r"{model_path_escaped}")
adapter_dir = {f'Path(r"{adapter_dir_escaped}")' if adapter_dir else 'None'}

try:
    # Step 1: Try to load config
    config_path = model_path / "config.json"
    if not config_path.exists():
        print("ERROR: config.json not found")
        sys.exit(1)
    
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    model_type = config.get("model_type", "unknown")
    print(f"MODEL_TYPE: {{model_type}}")
    
    # Step 2: Try AutoConfig.from_pretrained
    try:
        from transformers import AutoConfig
        cfg = AutoConfig.from_pretrained(str(model_path), trust_remote_code=True)
        print("AUTOCONFIG: OK")
    except Exception as e:
        error_str = str(e)
        if "does not recognize this architecture" in error_str or "model type" in error_str.lower():
            print("REASON: UNSUPPORTED_ARCH")
            print(f"ERROR: {{error_str}}")
            sys.exit(1)
        elif "ModuleNotFoundError" in str(type(e).__name__) or "ImportError" in str(type(e).__name__):
            print("REASON: MISSING_PACKAGE")
            print(f"ERROR: {{error_str}}")
            sys.exit(1)
        else:
            print("REASON: OTHER")
            print(f"ERROR: {{error_str}}")
            sys.exit(1)
    
    # Step 3: Try AutoTokenizer (lightweight check)
    try:
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(str(model_path), trust_remote_code=True)
        print("TOKENIZER: OK")
    except Exception as e:
        error_str = str(e)
        if "ModuleNotFoundError" in str(type(e).__name__) or "ImportError" in str(type(e).__name__):
            print("REASON: MISSING_PACKAGE")
            print(f"ERROR: {{error_str}}")
            sys.exit(1)
        # Tokenizer errors are often non-fatal, log but continue
        print(f"TOKENIZER_WARNING: {{error_str}}")
    
    # Step 4: Try lightweight model class resolution (meta device, no allocation)
    try:
        from transformers import AutoModelForCausalLM
        # Just check if the class can be resolved, don't actually load weights
        model_class = AutoModelForCausalLM
        print("MODEL_CLASS: OK")
    except Exception as e:
        error_str = str(e)
        if "ModuleNotFoundError" in str(type(e).__name__) or "ImportError" in str(type(e).__name__):
            print("REASON: MISSING_PACKAGE")
            print(f"ERROR: {{error_str}}")
            sys.exit(1)
        print(f"MODEL_CLASS_WARNING: {{error_str}}")
    
    print("PROBE: SUCCESS")
    sys.exit(0)
    
except Exception as e:
    error_str = str(e)
    print(f"REASON: OTHER")
    print(f"ERROR: {{error_str}}")
    sys.exit(1)
"""
        
        cmd = [str(python_exe), "-c", probe_code]
        log(f"Running model load probe: {cmd[0]} -c <code>")
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,  # Longer timeout for model loading
            **self.subprocess_flags
        )
        
        if result.returncode == 0:
            return True, None, None
        
        # Parse output to extract reason code
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        combined = stdout + "\n" + stderr
        
        reason_code = None
        error_msg = combined.strip()
        
        if "REASON: UNSUPPORTED_ARCH" in combined:
            reason_code = "UNSUPPORTED_ARCH"
            # Extract the actual error message
            for line in combined.splitlines():
                if line.startswith("ERROR:"):
                    error_msg = line.replace("ERROR:", "").strip()
                    break
        elif "REASON: MISSING_PACKAGE" in combined:
            reason_code = "MISSING_PACKAGE"
            for line in combined.splitlines():
                if line.startswith("ERROR:"):
                    error_msg = line.replace("ERROR:", "").strip()
                    break
        elif "REASON: REMOTE_CODE_REQUIRED" in combined:
            reason_code = "REMOTE_CODE_REQUIRED"
            for line in combined.splitlines():
                if line.startswith("ERROR:"):
                    error_msg = line.replace("ERROR:", "").strip()
                    break
        else:
            reason_code = "OTHER"
            # Use the last meaningful error line
            for line in reversed(combined.splitlines()):
                if line.strip() and not line.startswith("REASON:"):
                    error_msg = line.strip()
                    break
        
        log(f"Model load probe failed: {reason_code} - {error_msg[:200]}")
        return False, reason_code, error_msg

    def _collect_pip_debug_info(self, pip_exe: Path) -> dict:
        pip_version = subprocess.run(
            [str(pip_exe), "--version"],
            capture_output=True,
            text=True,
            timeout=30,
            **self.subprocess_flags
        )
        pip_freeze = subprocess.run(
            [str(pip_exe), "freeze"],
            capture_output=True,
            text=True,
            timeout=60,
            **self.subprocess_flags
        )
        return {
            "pip_version": (pip_version.stdout or pip_version.stderr or "").strip(),
            "pip_freeze": (pip_freeze.stdout or pip_freeze.stderr or "").strip(),
        }

    def _log_health_check_failure(self, result: subprocess.CompletedProcess, log_callback=None, pip_info: Optional[dict] = None) -> None:
        msg = (
            "Environment health check failed.\n"
            f"Command: {result.args}\n"
            f"Return code: {result.returncode}\n"
            f"STDOUT:\n{(result.stdout or '').strip()}\n"
            f"STDERR:\n{(result.stderr or '').strip()}\n"
        )
        if pip_info:
            msg += (
                f"PIP VERSION:\n{pip_info.get('pip_version', '')}\n"
                f"PIP FREEZE:\n{pip_info.get('pip_freeze', '')}\n"
            )
        if log_callback:
            log_callback(msg)

    def _format_health_check_error(self, result: subprocess.CompletedProcess, pip_info: Optional[dict] = None) -> str:
        msg = (
            "Environment health check failed.\n"
            f"Command: {result.args}\n"
            f"Return code: {result.returncode}\n"
            f"STDOUT:\n{(result.stdout or '').strip()}\n"
            f"STDERR:\n{(result.stderr or '').strip()}\n"
        )
        if pip_info:
            msg += (
                f"PIP VERSION:\n{pip_info.get('pip_version', '')}\n"
                f"PIP FREEZE:\n{pip_info.get('pip_freeze', '')}\n"
            )
        return msg

    def _health_check_indicates_cuda_mismatch(self, result: subprocess.CompletedProcess) -> bool:
        stdout = (result.stdout or "")
        stderr = (result.stderr or "")
        combined = (stdout + "\n" + stderr).lower()
        if "cuda build not installed or cuda unavailable" in combined:
            return True
        if "torch.version.cuda" in stdout and "None" in stdout:
            return True
        if "cuda is_available()" in stdout and "False" in stdout:
            return True
        # Detect CPU torch in CUDA env by missing +cu in torch.__version__
        for line in stdout.splitlines():
            if line.startswith("torch.__version__"):
                if "+cu" not in line:
                    return True
        return False

    def _health_check_env(self, python_exe: Path, profile_data: Optional[dict], env_key: Optional[str] = None) -> bool:
        """
        Run health checks on environment.
        
        Args:
            python_exe: Python executable path
            profile_data: Hardware profile data
            env_key: Optional env key (preferred for accelerator check)
        
        Returns:
            True if all checks pass
        """
        try:
            if env_key:
                result = self._run_env_health_check(python_exe, env_key)
            else:
                accelerator = self._derive_accelerator_from_profile(profile_data)
                code = self._build_health_check_code(accelerator)
                result = self._run_python(python_exe, code, timeout=60)
            return result.returncode == 0 and "OK" in (result.stdout or "")
        except Exception:
            return False

    def _write_env_debug_dump(
        self,
        env_dir: Path,
        env_key: str,
        python_exe: Path,
        pip_exe: Path,
        health_result: subprocess.CompletedProcess,
        log_callback=None,
    ) -> None:
        """
        Write env_debug.txt into the env folder with pip info and health output.
        """
        try:
            pip_info = self._collect_pip_debug_info(pip_exe)
            debug_path = env_dir / "env_debug.txt"
            debug_path.write_text(
                "\n".join([
                    f"env_key: {env_key}",
                    f"python: {python_exe}",
                    f"pip_version: {pip_info.get('pip_version', '')}",
                    "pip_freeze:",
                    pip_info.get("pip_freeze", ""),
                    "health_check_stdout:",
                    (health_result.stdout or "").strip(),
                    "health_check_stderr:",
                    (health_result.stderr or "").strip(),
                ]),
                encoding="utf-8"
            )
            if log_callback:
                log_callback(f"Wrote env debug dump: {debug_path}")
        except Exception as e:
            if log_callback:
                log_callback(f"Failed to write env debug dump: {e}")
    
    def _get_torch_info(self, python_exe: Path) -> tuple[str, bool]:
        """Get torch version and CUDA availability"""
        try:
            result = self._run_python(
                python_exe,
                "import torch; print(torch.__version__); print(torch.cuda.is_available())",
                timeout=20
            )
            if result.returncode == 0:
                lines = result.stdout.strip().split("\n")
                version = lines[0] if lines else "unknown"
                cuda = "True" in lines[1] if len(lines) > 1 else False
                return version, cuda
        except:
            pass
        return "unknown", False
    
    def _generate_constraints(self, python_exe: Path, env_key: str):
        """
        Generate constraints file from frozen packages.
        
        Args:
            python_exe: Python executable
            env_key: Environment key
        """
        try:
            result = subprocess.run(
                [str(python_exe), "-m", "pip", "freeze"],
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                constraints_file = self.constraints_dir / f"{env_key}.txt"
                constraints_file.write_text(result.stdout, encoding="utf-8")
        except Exception:
            pass  # Non-fatal
    
    def _install_inference_stack(
        self,
        python_exe: Path,
        profile_data: dict,
        log_callback=None,
        env_key: Optional[str] = None,
        force_reinstall: bool = False,
    ):
        """Install minimal inference stack"""
        def log(msg):
            if log_callback:
                log_callback(msg)
        
        pkgs = (profile_data or {}).get("packages", {}) if isinstance(profile_data, dict) else {}
        
        def _pkg(name: str, default: Optional[str] = None) -> Optional[str]:
            v = pkgs.get(name)
            if v is None:
                return default
            v = str(v).strip()
            if v.startswith(("==", ">=", "<=", ">", "<")):
                return f"{name}{v}"
            return f"{name}=={v}"
        
        # Check if this is an edge env (upgrade packages) or stable (pin versions)
        parsed = self.env_key_resolver.parse_env_key(env_key) if env_key else {}
        is_edge = parsed.get("tier") == "edge"
        
        if is_edge:
            # Edge env: use latest versions (upgrade)
            minimal_specs = [
                "typing_extensions>=4.12.2,<5.0.0",
                _pkg("numpy", "numpy"),
                _pkg("huggingface-hub", None),
                "transformers",  # Latest
                "tokenizers",  # Latest
                "protobuf",
                _pkg("safetensors", "safetensors"),
                _pkg("accelerate", "accelerate"),
                _pkg("peft", "peft"),
                _pkg("sentencepiece", "sentencepiece"),
                _pkg("pyyaml", "pyyaml"),
                _pkg("requests", "requests"),
            ]
        else:
            # Stable env: pin versions
            minimal_specs = [
                "typing_extensions>=4.12.2,<5.0.0",
                _pkg("numpy", "numpy==1.26.4"),
                _pkg("huggingface-hub", None),
                "transformers==4.51.3",
                "tokenizers==0.21.4",
                "protobuf",
                _pkg("safetensors", "safetensors>=0.7.0,<0.8.0"),
                _pkg("accelerate", "accelerate>=1.2.0,<1.3.0"),
                _pkg("peft", "peft>=0.13.0,<0.16.0"),
                _pkg("sentencepiece", "sentencepiece==0.2.0"),
                _pkg("pyyaml", "pyyaml>=6.0.0,<7.0.0"),
                _pkg("requests", "requests>=2.31.0,<3.0.0"),
            ]
        
        # Conditionally install bitsandbytes ONLY if env_key indicates bnb
        # Do not use substring matching like 'bnb' in env_key anywhere
        if env_key:
            parsed = self.env_key_resolver.parse_env_key(env_key)
            if parsed.get("quant") == "bnb":
                minimal_specs.append(_pkg("bitsandbytes", "bitsandbytes>=0.45.0,<0.50.0"))
                log("Installing bitsandbytes (required for bnb environment)")
            else:
                log("Skipping bitsandbytes (base environment)")
        
        minimal_specs = [s for s in minimal_specs if s]
        
        pip_exe = self._get_env_pip_executable(python_exe)
        if not pip_exe:
            raise RuntimeError(f"Pip executable not found: {python_exe.parent}")

        for spec in minimal_specs:
            log(f"Installing {spec}...")
            cmd = [str(pip_exe), "install", "--upgrade", spec]
            if force_reinstall:
                cmd.insert(3, "--force-reinstall")
            r = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=1800,
                **self.subprocess_flags
            )
            if r.returncode != 0:
                err = (r.stderr or r.stdout or "").strip()
                log(f"Warning: Failed to install {spec}: {err[:500]}")

    def _create_or_upgrade_edge_env(
        self,
        stable_env_key: str,
        profile_data: dict,
        log_callback=None
    ) -> Path:
        """
        Create edge environment from stable environment.
        If stable env exists, copies it and upgrades packages. Otherwise creates new edge env.
        
        Args:
            stable_env_key: Stable environment key (e.g., "tf-cu121-t22-base-stable")
            profile_data: Hardware profile data
            log_callback: Optional log callback
        
        Returns:
            Path to edge environment directory
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
        
        # Derive edge env key
        parsed = self.env_key_resolver.parse_env_key(stable_env_key)
        edge_env_key = self.env_key_resolver.resolve_env_key(
            backend=parsed["backend"],
            accelerator=parsed["accelerator"],
            torch_major_minor=parsed.get("torch_mm"),
            quant=parsed.get("quant"),
            profile_data=profile_data,
            tier="edge"
        )
        
        log(f"Creating/upgrading edge environment: {edge_env_key} from {stable_env_key}")
        
        # Check if edge env already exists
        edge_python_exe = self._get_env_python_executable(edge_env_key)
        edge_env_state = self.state_store.get_env(edge_env_key)
        
        if edge_python_exe and edge_python_exe.exists() and edge_env_state and edge_env_state.get('status') == 'READY':
            log(f"Edge environment {edge_env_key} already exists, upgrading packages...")
            # Upgrade key packages to latest
            upgrade_packages = [
                "transformers",
                "tokenizers",
                "accelerate",
                "safetensors",
                "peft",
                "huggingface-hub"
            ]
            for pkg in upgrade_packages:
                log(f"Upgrading {pkg} to latest...")
                subprocess.run(
                    [str(edge_python_exe), "-m", "pip", "install", "--upgrade", pkg],
                    capture_output=True,
                    text=True,
                    timeout=900,
                    **self.subprocess_flags
                )
            
            # Try installing transformers from GitHub if still needed (will be handled by probe)
            return self.envs_dir / edge_env_key
        
        # Check if stable env exists to copy from
        stable_python_exe = self._get_env_python_executable(stable_env_key)
        stable_env_path = self.envs_dir / stable_env_key
        
        if stable_python_exe and stable_python_exe.exists() and stable_env_path.exists():
            log(f"Copying stable environment {stable_env_key} to create edge environment...")
            # Copy stable env to edge
            edge_env_path = self.envs_dir / edge_env_key
            if edge_env_path.exists():
                self._rmtree_windows_safe(edge_env_path)
            
            if sys.platform == 'win32':
                shutil.copytree(stable_env_path, edge_env_path, dirs_exist_ok=True)
            else:
                shutil.copytree(stable_env_path, edge_env_path)
            
            edge_python_exe = self._get_env_python_executable(edge_env_key)
            if edge_python_exe and edge_python_exe.exists():
                # Upgrade packages in copied env
                log("Upgrading packages to latest versions...")
                upgrade_packages = [
                    "transformers",
                    "tokenizers",
                    "accelerate",
                    "safetensors",
                    "peft",
                    "huggingface-hub"
                ]
                for pkg in upgrade_packages:
                    log(f"Upgrading {pkg}...")
                    subprocess.run(
                        [str(edge_python_exe), "-m", "pip", "install", "--upgrade", pkg],
                        capture_output=True,
                        text=True,
                        timeout=900,
                        **self.subprocess_flags
                    )
                
                # Update StateStore
                torch_version, cuda_available = self._get_torch_info(edge_python_exe)
                self.state_store.upsert_env(
                    env_key=edge_env_key,
                    python_path=str(edge_python_exe),
                    torch_version=torch_version,
                    cuda_version=profile_data.get("cuda_version", "cpu"),
                    backend="transformers",
                    status="READY"
                )
                
                return edge_env_path
        
        # If no stable env to copy from, create edge env from scratch
        log(f"Creating new edge environment {edge_env_key}...")
        self._atomic_create_env(edge_env_key, profile_data, log_callback=log_callback)
        return self.envs_dir / edge_env_key

    def _create_dedicated_env(
        self,
        dedicated_env_key: str,
        base_env_key: str,
        profile_data: dict,
        log_callback=None,
        required_packages: Optional[list] = None,
    ) -> Path:
        """
        Create a dedicated environment for a specific model by copying a base environment.
        For GPTQ (when required_packages includes auto-gptq): delete and recreate fresh
        with Python 3.11 via _atomic_create_env instead of copying.
        
        Args:
            dedicated_env_key: The new dedicated environment key
            base_env_key: The shared environment key to copy from
            profile_data: Hardware profile data
            log_callback: Optional log callback
            required_packages: Model-specific packages (e.g. auto-gptq); used to detect GPTQ.
            
        Returns:
            Path to the new dedicated environment directory
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
            import logging
            logging.info(msg)
            
        required_packages = required_packages or []
        needs_fresh_gptq = any(p and "auto-gptq" in str(p).lower() for p in required_packages)

        if needs_fresh_gptq:
            log(f"GPTQ: creating dedicated env fresh with Python 3.11 (no copy)")
            dedicated_env_path = self.envs_dir / dedicated_env_key
            if dedicated_env_path.exists():
                log(f"Removing existing dedicated env for fresh GPTQ build")
                self._rmtree_windows_safe(dedicated_env_path)
            base_python_exe = self._get_base_python_for_env(dedicated_env_key, required_packages, log_callback)
            if not base_python_exe or not base_python_exe.exists():
                base_python_exe = self._find_windows_python("3.11", log_callback=log_callback)
            if not base_python_exe or not base_python_exe.exists():
                raise RuntimeError(
                    "GPTQ requires Python 3.11 for auto-gptq wheels; bundled Python 3.11 not available. "
                    "Install Python 3.11 and ensure it is discoverable via 'py -3.11' on Windows."
                )
            self._atomic_create_env(
                dedicated_env_key, profile_data,
                log_callback=log_callback,
                base_python_exe=base_python_exe
            )
            dedicated_python_exe = self._get_env_python_executable(dedicated_env_key)
            if not (dedicated_python_exe and dedicated_python_exe.exists()):
                raise RuntimeError(f"Failed to create dedicated GPTQ environment: {dedicated_env_key}")
            torch_version, _ = self._get_torch_info(dedicated_python_exe)
            self.state_store.upsert_env(
                env_key=dedicated_env_key,
                python_path=str(dedicated_python_exe),
                torch_version=torch_version,
                cuda_version=profile_data.get("cuda_version", "cpu"),
                backend="transformers",
                status="READY"
            )
            log(f"Dedicated GPTQ environment {dedicated_env_key} ready!")
            return self.envs_dir / dedicated_env_key

        log(f"Creating dedicated environment: {dedicated_env_key} from {base_env_key}")
        
        # Check if dedicated env already exists
        dedicated_python_exe = self._get_env_python_executable(dedicated_env_key)
        dedicated_env_state = self.state_store.get_env(dedicated_env_key)
        
        if dedicated_python_exe and dedicated_python_exe.exists() and dedicated_env_state:
            log(f"Dedicated environment {dedicated_env_key} already exists.")
            
            # ALWAYS verify torch/transformers exist, even in existing environments
            # This is critical for BROKEN environments where installation failed
            log("Verifying critical packages in existing dedicated environment...")
            missing_critical = self.check_missing_packages(dedicated_python_exe, ["torch", "transformers"])
            if missing_critical:
                log(f"WARNING: Critical packages missing: {missing_critical}")
                log("Attempting to reinstall missing packages...")
                # Get the accelerator and backend info from the base env
                parsed = self.env_key_resolver.parse_env_key(base_env_key)
                accelerator = parsed.get("accelerator", "cpu")
                
                # Install torch with the correct CUDA version
                if accelerator.startswith("cu"):
                    torch_index_url = f"https://download.pytorch.org/whl/{accelerator}"
                    for pkg in missing_critical:
                        log(f"Installing {pkg} with CUDA support...")
                        result = subprocess.run(
                            [str(dedicated_python_exe), "-m", "pip", "install", pkg, "--index-url", torch_index_url],
                            capture_output=True,
                            text=True,
                            timeout=600,
                            **self.subprocess_flags
                        )
                        if result.returncode != 0:
                            error = (result.stderr or result.stdout or "").strip()[:500]
                            raise RuntimeError(f"Failed to install {pkg} in existing dedicated env: {error}")
                else:
                    for pkg in missing_critical:
                        log(f"Installing {pkg}...")
                        result = subprocess.run(
                            [str(dedicated_python_exe), "-m", "pip", "install", pkg],
                            capture_output=True,
                            text=True,
                            timeout=600,
                            **self.subprocess_flags
                        )
                        if result.returncode != 0:
                            error = (result.stderr or result.stdout or "").strip()[:500]
                            raise RuntimeError(f"Failed to install {pkg} in existing dedicated env: {error}")
                
                # Re-verify
                still_missing = self.check_missing_packages(dedicated_python_exe, ["torch", "transformers"])
                if still_missing:
                    raise RuntimeError(f"Failed to install critical packages in existing dedicated env: {still_missing}")
                log("Successfully installed missing critical packages in existing environment")
            else:
                log("Critical packages verified OK in existing dedicated environment")
            
            # Update state store to ensure it's marked READY
            torch_version, cuda_available = self._get_torch_info(dedicated_python_exe)
            self.state_store.upsert_env(
                env_key=dedicated_env_key,
                python_path=str(dedicated_python_exe),
                torch_version=torch_version,
                cuda_version=profile_data.get("cuda_version", "cpu"),
                backend="transformers",
                status="READY"
            )
            
            return self.envs_dir / dedicated_env_key
            
        # Check if base env exists to copy from
        base_python_exe = self._get_env_python_executable(base_env_key)
        base_env_path = self.envs_dir / base_env_key
        
        if not (base_python_exe and base_python_exe.exists() and base_env_path.exists()):
            log(f"Base environment {base_env_key} not found, creating it first...")
            self.ensure_env_exists(base_env_key, profile_data, log_callback=log_callback)
            base_env_path = self.envs_dir / base_env_key
            base_python_exe = self._get_env_python_executable(base_env_key)
            
        log(f"Copying base environment {base_env_key} to {dedicated_env_key}...")
        dedicated_env_path = self.envs_dir / dedicated_env_key
        if dedicated_env_path.exists():
            self._rmtree_windows_safe(dedicated_env_path)
            
        # Mark as CREATING in StateStore
        self.state_store.upsert_env(
            env_key=dedicated_env_key,
            status="CREATING"
        )
        
        try:
            if sys.platform == 'win32':
                shutil.copytree(base_env_path, dedicated_env_path, dirs_exist_ok=True)
            else:
                shutil.copytree(base_env_path, dedicated_env_path)
                
            dedicated_python_exe = self._get_env_python_executable(dedicated_env_key)
            if not (dedicated_python_exe and dedicated_python_exe.exists()):
                raise RuntimeError(f"Failed to create dedicated environment: {dedicated_python_exe} not found after copy")
            
            # CRITICAL: Verify torch was copied successfully
            log("Verifying torch installation in dedicated environment...")
            missing_critical = self.check_missing_packages(dedicated_python_exe, ["torch", "transformers"])
            if missing_critical:
                log(f"WARNING: Critical packages missing after copy: {missing_critical}")
                log("Attempting to reinstall missing packages...")
                # Get the accelerator and backend info from the base env
                parsed = self.env_key_resolver.parse_env_key(base_env_key)
                accelerator = parsed.get("accelerator", "cpu")
                
                # Install torch with the correct CUDA version
                if accelerator.startswith("cu"):
                    torch_index_url = f"https://download.pytorch.org/whl/{accelerator}"
                    for pkg in missing_critical:
                        log(f"Installing {pkg} with CUDA support...")
                        result = subprocess.run(
                            [str(dedicated_python_exe), "-m", "pip", "install", pkg, "--index-url", torch_index_url],
                            capture_output=True,
                            text=True,
                            timeout=600,
                            **self.subprocess_flags
                        )
                        if result.returncode != 0:
                            error = (result.stderr or result.stdout or "").strip()[:500]
                            raise RuntimeError(f"Failed to install {pkg} in dedicated env: {error}")
                else:
                    for pkg in missing_critical:
                        log(f"Installing {pkg}...")
                        result = subprocess.run(
                            [str(dedicated_python_exe), "-m", "pip", "install", pkg],
                            capture_output=True,
                            text=True,
                            timeout=600,
                            **self.subprocess_flags
                        )
                        if result.returncode != 0:
                            error = (result.stderr or result.stdout or "").strip()[:500]
                            raise RuntimeError(f"Failed to install {pkg} in dedicated env: {error}")
                
                # Re-verify
                still_missing = self.check_missing_packages(dedicated_python_exe, ["torch", "transformers"])
                if still_missing:
                    raise RuntimeError(f"Failed to install critical packages in dedicated env: {still_missing}")
                log("Successfully installed missing critical packages")
                
            # Update StateStore
            torch_version, cuda_available = self._get_torch_info(dedicated_python_exe)
            self.state_store.upsert_env(
                env_key=dedicated_env_key,
                python_path=str(dedicated_python_exe),
                torch_version=torch_version,
                cuda_version=profile_data.get("cuda_version", "cpu"),
                backend="transformers",
                status="READY"
            )
            
            log(f"Dedicated environment {dedicated_env_key} ready!")
            return dedicated_env_path
        except Exception as e:
            # Mark as FAILED in StateStore
            self.state_store.upsert_env(
                env_key=dedicated_env_key,
                status="FAILED",
                last_error=str(e)[:500]
            )
            raise RuntimeError(f"Failed to create dedicated environment {dedicated_env_key}: {e}")
    
    def _upgrade_edge_env_for_unsupported_arch(
        self,
        python_exe: Path,
        log_callback=None
    ) -> bool:
        """
        Upgrade edge environment with transformers from GitHub source for unsupported architectures.
        
        Args:
            python_exe: Python executable in edge environment
            log_callback: Optional log callback
        
        Returns:
            True if upgrade succeeded
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
        
        # Prefer VCS install (requires `git`), but fall back to GitHub zip (no git needed).
        candidates = [
            ("git", "git+https://github.com/huggingface/transformers.git"),
            ("zip", "https://github.com/huggingface/transformers/archive/refs/heads/main.zip"),
        ]

        for kind, spec in candidates:
            log(f"Upgrading transformers from {kind} source: {spec}")
            result = subprocess.run(
                [str(python_exe), "-m", "pip", "install", "--upgrade", spec],
                capture_output=True,
                text=True,
                timeout=900,
                **self.subprocess_flags
            )

            if result.returncode == 0:
                log(f"Successfully installed transformers from {kind} source")
                return True

            err = (result.stderr or result.stdout or "").strip()
            log(f"Failed transformers install ({kind}): {err[:800]}")

        return False
    
    def _run_python(self, python_exe: Path, code: str, timeout: int = 30) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str(python_exe), "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
            **self.subprocess_flags
        )

    def _verify_autogptq_cuda_kernels(self, python_exe: Path) -> tuple[bool, str]:
        """
        Verify auto-gptq CUDA kernels load. If "CUDA extension not installed" appears,
        model startup will crash with 0xC0000005.
        Returns (success: bool, error_message: str).
        """
        verify_code = """
import sys
import logging
logging.basicConfig(level=logging.WARNING)
try:
    import auto_gptq  # noqa: F401
    from auto_gptq.nn_modules.qlinear import qlinear_cuda_old
except Exception as e:
    print('IMPORT_ERROR:', e, file=sys.stderr)
    sys.exit(2)
sys.exit(0)
"""
        try:
            r = self._run_python(python_exe, verify_code, timeout=30)
            out = (r.stdout or "") + (r.stderr or "")
            if "CUDA extension not installed" in out:
                return False, "auto-gptq reports 'CUDA extension not installed'. Reinstall from pre-built wheels or use a different model."
            if r.returncode == 0:
                return True, ""
            return False, f"Verification failed (exit {r.returncode}): {out[:500]}"
        except Exception as e:
            return False, str(e)

    def _env_needs_cuda_torch(self, python_exe: Path, profile_data: Optional[dict]) -> bool:
        """
        Return True if the active profile expects CUDA torch, but this env does not have CUDA torch.
        """
        if not profile_data:
            return False
        try:
            torch_spec = str(profile_data.get("packages", {}).get("torch", ""))
            torch_index = str(profile_data.get("torch_index", ""))
            expects_cuda = ("+cu" in torch_spec) or ("/whl/cu" in torch_index)
            if not expects_cuda:
                return False

            # Check current env torch state
            r = self._run_python(
                python_exe,
                "import torch; print(torch.__version__); print('CUDA', torch.cuda.is_available())",
                timeout=20,
            )
            if r.returncode != 0:
                return True
            out = (r.stdout or "").lower()
            cuda_ok = "cuda true" in out
            has_cu = "+cu" in (r.stdout or "")
            return not (cuda_ok and has_cu)
        except Exception:
            return True

    def _ensure_profile_torch(self, python_exe: Path, profile_data: dict, log_callback=None) -> None:
        """
        Ensure the per-model environment has the correct torch stack for the active profile.
        Installs from profile_data['torch_index'] with the exact versions in profile_data['packages'].
        """
        def log(msg: str):
            if log_callback:
                log_callback(msg)
            import logging
            logging.info(msg)

        pkgs = profile_data.get("packages", {}) or {}
        torch_spec = pkgs.get("torch")
        torchvision_spec = pkgs.get("torchvision")
        torchaudio_spec = pkgs.get("torchaudio")
        torch_index = profile_data.get("torch_index")

        if not (torch_spec and torchvision_spec and torchaudio_spec and torch_index):
            log("Profile missing torch stack details; skipping CUDA torch enforcement.")
            return

        # Normalize to pip specs
        def _spec(name: str, ver: str) -> str:
            ver = str(ver).strip()
            if ver.startswith(("==", ">=", "<=", ">", "<")):
                return f"{name}{ver}"
            return f"{name}=={ver}"

        torch_pkg = _spec("torch", torch_spec)
        tv_pkg = _spec("torchvision", torchvision_spec)
        ta_pkg = _spec("torchaudio", torchaudio_spec)

        log(f"Ensuring CUDA torch stack in per-model env: {torch_pkg} ({torch_index})")

        pip_exe = self._get_env_pip_executable(python_exe)
        if not pip_exe:
            raise RuntimeError(f"Pip executable not found: {python_exe.parent}")

        # Uninstall any existing stack first (avoid mixed CPU/CUDA wheels)
        for pkg in ["torch", "torchvision", "torchaudio", "xformers", "triton", "triton-windows"]:
            try:
                subprocess.run(
                    [str(pip_exe), "uninstall", "-y", pkg],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    **self.subprocess_flags
                )
            except Exception:
                pass

        # Install in order: torch -> torchvision -> torchaudio
        for pkg_spec in [torch_pkg, tv_pkg, ta_pkg]:
            log(f"Installing {pkg_spec} ...")
            r = subprocess.run(
                [
                    str(pip_exe),
                    "install",
                    "--index-url",
                    str(torch_index),
                    "--force-reinstall",
                    "--no-deps",
                    pkg_spec,
                ],
                capture_output=True,
                text=True,
                timeout=1800,
                **self.subprocess_flags
            )
            if r.returncode != 0:
                err = (r.stderr or r.stdout or "").strip()
                raise RuntimeError(f"Failed to install {pkg_spec} in per-model env: {err[:800]}")

        # Verify torch is CUDA and matches expected build
        verify = self._run_python(
            python_exe,
            "import torch; print(torch.__version__); assert torch.cuda.is_available(); print('OK')",
            timeout=30,
        )
        if verify.returncode != 0:
            raise RuntimeError(
                f"Per-model env torch verification failed.\nSTDOUT:\n{verify.stdout}\nSTDERR:\n{verify.stderr}"
            )
    
    def _check_old_env_health(self, python_exe: Path, profile_data: Optional[dict]) -> bool:
        """
        Check if an old per-model environment is healthy and usable.
        
        Args:
            python_exe: Python executable path from old environment
            profile_data: Hardware profile data
        
        Returns:
            True if environment is healthy and has all required packages
        """
        if not python_exe or not python_exe.exists():
            return False
        
        try:
            # Check basic imports (more lenient than new env health check)
            # NOTE: peft is only required when using adapters. Old env health should not require it.
            code = "import torch, transformers, accelerate\n"
            
            # If CUDA profile, verify CUDA is available
            if profile_data:
                torch_spec = str(profile_data.get("packages", {}).get("torch", ""))
                torch_index = str(profile_data.get("torch_index", ""))
                require_cuda = ("+cu" in torch_spec) or ("/whl/cu" in torch_index)
                
                if require_cuda:
                    # For old envs, just check if CUDA is available, don't require specific version
                    code += "assert torch.cuda.is_available(), 'CUDA not available'\n"
            
            code += "print('OK')"
            
            result = self._run_python(python_exe, code, timeout=30)
            return result.returncode == 0 and "OK" in result.stdout
        except Exception:
            return False
    
    def resolve_env_for_model(
        self,
        model_path: str,
        adapter_dir: Optional[str] = None,
        profile_data: Optional[dict] = None,
        tier: str = "stable"
    ) -> tuple[str, str, str]:
        """
        Pure function: resolve env_key, accelerator, backend for a model (no side effects).
        
        Args:
            model_path: Path to base model
            adapter_dir: Optional adapter directory
            profile_data: Hardware profile data (if None, auto-detected)
            tier: Environment capability tier "stable" | "edge" (defaults to "stable")
        
        Returns:
            Tuple of (env_key, accelerator, backend)
        """
        if profile_data is None:
            profile_data = self._get_active_profile_data()
            if not profile_data:
                raise RuntimeError("Could not determine hardware profile")
        
        # Detect model requirements
        from core.envs.model_requirement_detector import detect_model_requirements
        req = detect_model_requirements(model_path, adapter_dir)
        
        # Derive accelerator
        accelerator = self._derive_accelerator_from_profile(profile_data)
        
        # Choose backend and quant
        if req["backend_required"] == "llamacpp":
            backend = "llamacpp"
            quant = None
        else:
            backend = "tf"
            quant = "bnb" if req["needs_bnb"] else "base"
        
        # Resolve env_key with tier
        env_key = self.env_key_resolver.resolve_env_key(
            backend=backend,
            accelerator=accelerator,
            torch_major_minor=None,
            quant=quant,
            profile_data=profile_data,
            tier=tier
        )
        
        return env_key, accelerator, backend
    
    def ensure_env_exists(
        self,
        env_key: str,
        profile_data: Optional[dict] = None,
        log_callback=None
    ) -> EnvSpec:
        """
        Ensure environment exists, creating if missing.
        
        Args:
            env_key: Environment key
            profile_data: Hardware profile data (if None, auto-detected)
            log_callback: Optional log callback
        
        Returns:
            EnvSpec for the environment
        """
        if profile_data is None:
            profile_data = self._get_active_profile_data()
            if not profile_data:
                raise RuntimeError("Could not determine hardware profile")
        
        # Check if env already exists and is healthy
        python_exe = self._get_env_python_executable(env_key)
        env_state = self.state_store.get_env(env_key)
        
        if python_exe and python_exe.exists() and env_state and env_state.get('status') == 'READY':
            if self._health_check_env(python_exe, profile_data, env_key=env_key):
                return EnvSpec(
                    key=env_key,
                    python_executable=python_exe,
                    metadata={"env_key": env_key, "status": "READY", "source": "existing"}
                )
        
        # Create new environment
        self._atomic_create_env(env_key, profile_data, log_callback=log_callback)
        
        python_exe = self._get_env_python_executable(env_key)
        if not python_exe or not python_exe.exists():
            raise RuntimeError(f"Environment created but Python executable not found: {python_exe}")
        
        return EnvSpec(
            key=env_key,
            python_executable=python_exe,
            metadata={"env_key": env_key, "status": "READY", "source": "created"}
        )
    
    def run_env_health_check(
        self,
        env_key: str,
        profile_data: Optional[dict] = None,
        log_callback=None
    ) -> tuple[subprocess.CompletedProcess, Optional[str]]:
        """
        Run health check on environment and return result + log path.
        
        Args:
            env_key: Environment key
            profile_data: Hardware profile data (if None, auto-detected)
            log_callback: Optional log callback
        
        Returns:
            Tuple of (CompletedProcess result, log_file_path)
        """
        if profile_data is None:
            profile_data = self._get_active_profile_data()
        
        python_exe = self._get_env_python_executable(env_key)
        if not python_exe or not python_exe.exists():
            raise RuntimeError(f"Environment not found: {env_key}")
        
        # Run health check
        result = self._run_env_health_check(python_exe, env_key, log_callback=log_callback)
        
        # Write log to temp file
        log_path = None
        try:
            import tempfile
            log_file = tempfile.NamedTemporaryFile(
                mode='w',
                prefix=f"healthcheck_{env_key}_",
                suffix='.txt',
                delete=False
            )
            log_file.write(f"Health check for env: {env_key}\n")
            log_file.write(f"Command: {result.args}\n")
            log_file.write(f"Return code: {result.returncode}\n")
            log_file.write(f"STDOUT:\n{result.stdout or ''}\n")
            log_file.write(f"STDERR:\n{result.stderr or ''}\n")
            log_file.close()
            log_path = log_file.name
        except Exception as e:
            if log_callback:
                log_callback(f"Failed to write health check log: {e}")
        
        return result, log_path
    
    def repair_env_once(
        self,
        env_key: str,
        profile_data: Optional[dict] = None,
        log_callback=None
    ) -> None:
        """
        Attempt one-time repair of environment (install missing packages, fix torch, etc.).
        
        Args:
            env_key: Environment key
            profile_data: Hardware profile data (if None, auto-detected)
            log_callback: Optional log callback
        """
        if profile_data is None:
            profile_data = self._get_active_profile_data()
            if not profile_data:
                raise RuntimeError("Could not determine hardware profile")
        
        python_exe = self._get_env_python_executable(env_key)
        if not python_exe or not python_exe.exists():
            raise RuntimeError(f"Environment not found: {env_key}")
        
        def log(msg):
            if log_callback:
                log_callback(msg)
            logger.info(msg)
        
        # Check for missing packages
        missing = self.check_missing_packages(
            python_exe,
            required_packages=["transformers", "safetensors", "tokenizers", "accelerate", "protobuf"]
        )
        if missing:
            log(f"Installing missing packages: {missing}")
            success, error = self.auto_install_missing_packages(python_exe, missing, log_callback=log_callback)
            if not success:
                log(f"Failed to install missing packages: {error}")
        
        # Check for CUDA torch mismatch
        parsed = self.env_key_resolver.parse_env_key(env_key)
        accelerator = parsed.get("accelerator", "cpu")
        if accelerator.startswith("cu"):
            if self._env_needs_cuda_torch(python_exe, profile_data):
                log("Reinstalling CUDA torch stack...")
                self._ensure_profile_torch(python_exe, profile_data, log_callback=log_callback)
        
        # Reinstall inference stack if needed
        log("Reinstalling inference stack...")
        self._install_inference_stack(
            python_exe,
            profile_data,
            log_callback=log_callback,
            env_key=env_key,
            force_reinstall=False
        )
    
    def get_env_for_model(self, model_path: str, log_callback=None) -> EnvSpec:
        """
        PHASE 2: Get environment spec for a model using env_key.
        
        MIGRATION STRATEGY:
        1. Check if new shared env exists and is healthy -> use it
        2. Check if old per-model env exists and is healthy -> use it as fallback
        3. Create new shared env if neither exists
        
        This allows graceful migration without breaking existing setups.
        
        Args:
            model_path: Path to the model (base model path)
            log_callback: Optional function to call with log messages
            
        Returns:
            EnvSpec with validated python executable path
            
        Raises:
            RuntimeError: If environment creation/validation fails
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
            import logging
            logging.info(msg)
        
        # Get profile data
        profile_data = self._get_active_profile_data()
        if not profile_data:
            raise RuntimeError("Could not determine hardware profile")
        
        # Detect model requirements from configs
        from core.envs.model_requirement_detector import detect_model_requirements
        
        # Try to get adapter_dir from model directory structure
        # Check if model_path contains adapter files or if there's a separate adapter directory
        adapter_dir = None
        model_path_obj = Path(model_path)
        
        # Check if this directory itself is an adapter (has adapter_config.json)
        adapter_config_path = model_path_obj / "adapter_config.json"
        if adapter_config_path.exists():
            # This might be an adapter directory, but we need the base model path
            # For now, pass None - the detector will check the adapter config itself
            adapter_dir = str(model_path_obj)
        else:
            # Check parent directory for adapter
            parent = model_path_obj.parent
            if parent.exists():
                parent_adapter_config = parent / "adapter_config.json"
                if parent_adapter_config.exists():
                    adapter_dir = str(parent)
        
        req = detect_model_requirements(model_path, adapter_dir)
        log(f"Detected model requirements: {req}")
        
        # Derive accelerator from profile_data
        accelerator = self._derive_accelerator_from_profile(profile_data)
        log(f"Derived accelerator: {accelerator}")
        
        # Choose backend and quant based on requirements
        if req["backend_required"] == "llamacpp":
            backend = "llamacpp"
            quant = None
        else:
            backend = "tf"  # vllm chosen by policy elsewhere
            quant = "bnb" if req["needs_bnb"] else "base"
        
        # Resolve env_key using new format (default to stable tier)
        env_key = self.env_key_resolver.resolve_env_key(
            backend=backend,
            accelerator=accelerator,
            torch_major_minor=None,  # Will be derived from profile_data
            quant=quant,
            profile_data=profile_data,
            tier="stable"  # Default to stable for get_env_for_model
        )
        
        log(f"Resolved env_key: {env_key}")
        
        # STRATEGY 1: Check for existing compatible environments
        # Enumerate all existing envs and check compatibility
        compatible_env_key = None
        if self.envs_dir.exists():
            for env_dir in self.envs_dir.iterdir():
                if not env_dir.is_dir() or env_dir.name.startswith("."):
                    continue
                
                candidate_key = env_dir.name
                if self._is_env_compatible(candidate_key, req, accelerator):
                    # Check if it's healthy
                    candidate_exe = self._get_env_python_executable(candidate_key)
                    if candidate_exe and candidate_exe.exists():
                        env_state = self.state_store.get_env(candidate_key)
                        if env_state and env_state.get('status') == 'READY':
                            if self._health_check_env(candidate_exe, profile_data, env_key=candidate_key):
                                compatible_env_key = candidate_key
                                log(f"Found compatible existing environment: {candidate_key}")
                                break
        
        # If we found a compatible env, use it
        if compatible_env_key:
            python_exe = self._get_env_python_executable(compatible_env_key)
            log(f"Using compatible existing environment: {compatible_env_key}")
            return EnvSpec(
                key=compatible_env_key,
                python_executable=python_exe,
                metadata={"env_key": compatible_env_key, "status": "READY", "source": "shared-compatible"}
            )
        
        # STRATEGY 2: Check for exact env_key match (new shared environment)
        env_state = self.state_store.get_env(env_key)
        python_exe = self._get_env_python_executable(env_key)
        
        if python_exe and python_exe.exists() and env_state and env_state['status'] == 'READY':
            # Verify health
            if self._health_check_env(python_exe, profile_data, env_key=env_key):
                log(f"Using existing shared environment: {env_key}")
                return EnvSpec(
                    key=env_key,
                    python_executable=python_exe,
                    metadata={"env_key": env_key, "status": "READY", "source": "shared"}
                )
            else:
                log(f"Existing shared environment {env_key} failed health check")
        
        # STRATEGY 3: Fallback to old per-model environment (MIGRATION PATH)
        old_env_path = self.env_manager.get_python_executable(model_path=model_path)
        if old_env_path and old_env_path.exists():
            log(f"Checking old per-model environment: {old_env_path}")
            if self._check_old_env_health(old_env_path, profile_data):
                log(f"✓ Using healthy old per-model environment (migration fallback)")
                log(f"  To migrate to new shared envs, delete: {old_env_path.parent.parent}")
                
                # Create a pseudo env_key for the old environment
                old_env_key = f"legacy-{Path(model_path).name}"
                
                return EnvSpec(
                    key=old_env_key,
                    python_executable=old_env_path,
                    metadata={
                        "env_key": old_env_key,
                        "status": "READY",
                        "source": "legacy-per-model",
                        "migration_target": env_key
                    }
                )
            else:
                log(f"Old per-model environment exists but is unhealthy, will create new shared env")
        
        # STRATEGY 4: Check for ongoing creation (idempotency)
        if env_state and env_state['status'] == 'CREATING':
            raise RuntimeError(
                f"Environment {env_key} is already being created. "
                f"Please wait for the other creation to complete."
            )
        
        # STRATEGY 5: Create new shared environment
        log(f"Creating new shared environment: {env_key}")
        try:
            self._atomic_create_env(env_key, profile_data, log_callback=log_callback)
        except Exception as e:
            # If creation fails and we have an old env, fall back to it even if unhealthy
            if old_env_path and old_env_path.exists():
                log(f"⚠ New env creation failed, attempting to use old environment as last resort")
                old_env_key = f"legacy-{Path(model_path).name}"
                return EnvSpec(
                    key=old_env_key,
                    python_executable=old_env_path,
                    metadata={
                        "env_key": old_env_key,
                        "status": "DEGRADED",
                        "source": "legacy-per-model-fallback",
                        "warning": "Using old environment as fallback after creation failure"
                    }
                )
            raise
        
        # Get Python executable from newly created env
        python_exe = self._get_env_python_executable(env_key)
        if not python_exe or not python_exe.exists():
            raise RuntimeError(f"Environment created but Python executable not found: {python_exe}")
        
        return EnvSpec(
            key=env_key,
            python_executable=python_exe,
            metadata={"env_key": env_key, "status": "READY", "source": "shared"}
        )
    
    def _has_server_dependencies(self, python_exe: Path) -> bool:
        """
        Check if server and ML dependencies are installed.
        
        Args:
            python_exe: Path to Python executable
            
        Returns:
            True if uvicorn, fastapi, transformers, peft, and torch are available.
            If the active profile expects CUDA torch, this also requires torch.cuda.is_available().
        """
        return self._health_check_env(python_exe, self._get_active_profile_data())
    
    def check_missing_packages(self, python_exe: Path, required_packages: list = None) -> list:
        """
        Check which required packages are missing from the environment.
        
        Args:
            python_exe: Path to Python executable
            required_packages: List of package names to check (default: critical inference packages)
            
        Returns:
            List of missing package names (empty if all present)
        """
        if required_packages is None:
            required_packages = ["protobuf", "transformers", "tokenizers", "torch"]
        
        # Map package names to their import names (some packages have different import names)
        import_map = {
            "protobuf": "google.protobuf",  # protobuf package is imported as google.protobuf
            "auto-gptq": "auto_gptq",        # PyPI name uses hyphen; import uses underscore
        }
        
        missing = []
        for pkg in required_packages:
            try:
                # Use import name if mapped, otherwise use package name
                import_name = import_map.get(pkg, pkg)
                code = f"import {import_name}; print('OK')"
                result = self._run_python(python_exe, code, timeout=10)
                if result.returncode != 0 or "OK" not in result.stdout:
                    missing.append(pkg)
            except Exception:
                missing.append(pkg)
        
        return missing
    
    def auto_install_missing_packages(self, python_exe: Path, packages: list, log_callback=None) -> tuple[bool, str]:
        """
        Automatically install missing packages in the environment.
        
        Args:
            python_exe: Path to Python executable
            packages: List of package names to install
            log_callback: Optional callback for logging
            
        Returns:
            Tuple of (success: bool, error_details: str)
            - success: True if all packages installed successfully, False otherwise
            - error_details: Empty string if success, detailed error message if failed
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
        
        errors = []
        for pkg in packages:
            log(f"Installing missing package: {pkg}...")
            try:
                pkg_norm = (pkg or "").strip().lower()
                # Prefer calling the venv pip directly (more reliable and avoids PATH issues)
                pip_exe = self._get_env_pip_executable(python_exe) or Path(str(python_exe))
                if str(pip_exe).endswith("python.exe") or str(pip_exe).endswith("python"):
                    # Fallback if pip executable not found
                    pip_cmd = [str(python_exe), "-m", "pip", "install", pkg]
                else:
                    pip_cmd = [str(pip_exe), "install", pkg]
                timeout_s = 300
                env = None

                # Deterministic repair for known core packages:
                # - use pinned specs for stable envs
                # - avoid dependency resolution churn by using --no-deps where safe
                # This prevents "it was there before, now it's gone" behavior caused by pip upgrading/downgrading.
                try:
                    env_key = python_exe.parent.parent.parent.name  # ...\.envs\<env_key>\.venv\Scripts\python.exe
                except Exception:
                    env_key = ""
                parsed_env = {}
                try:
                    parsed_env = self.env_key_resolver.parse_env_key(env_key) if env_key else {}
                except Exception:
                    parsed_env = {}
                is_edge = (parsed_env.get("tier") == "edge")

                pinned_map_stable = {
                    "transformers": "transformers==4.51.3",
                    "tokenizers": "tokenizers==0.21.4",
                    "accelerate": "accelerate>=1.2.0,<1.3.0",
                    "peft": "peft>=0.13.0,<0.16.0",
                    "safetensors": "safetensors>=0.7.0,<0.8.0",
                }
                # Keep protobuf unpinned (many packages depend on it, and pinning can backfire)
                if not is_edge and pkg_norm in pinned_map_stable:
                    spec = pinned_map_stable[pkg_norm]
                    if str(pip_exe).endswith("python.exe") or str(pip_exe).endswith("python"):
                        pip_cmd = [str(python_exe), "-m", "pip", "install", "--upgrade", "--no-deps", spec]
                    else:
                        pip_cmd = [str(pip_exe), "install", "--upgrade", "--no-deps", spec]
                elif is_edge and pkg_norm in {"transformers", "tokenizers", "accelerate", "peft", "safetensors"}:
                    # Edge envs intentionally track latest; still avoid dependency churn.
                    if str(pip_exe).endswith("python.exe") or str(pip_exe).endswith("python"):
                        pip_cmd = [str(python_exe), "-m", "pip", "install", "--upgrade", "--no-deps", pkg_norm]
                    else:
                        pip_cmd = [str(pip_exe), "install", "--upgrade", "--no-deps", pkg_norm]
                
                # GPTQ: install from HuggingFace pre-built CUDA wheels to avoid source-build crashes.
                # Source builds often leave "CUDA extension not installed" and cause 0xC0000005.
                if pkg_norm.startswith("auto-gptq"):
                    accelerator = (parsed_env.get("accelerator") or "").lower()
                    if not accelerator or accelerator == "cpu":
                        # Infer from profile if env key lacks accelerator
                        profile = self._get_active_profile_data()
                        if profile:
                            torch_spec = str(profile.get("packages", {}).get("torch", ""))
                            if "+cu124" in torch_spec:
                                accelerator = "cu124"
                            elif "+cu121" in torch_spec or "+cu12" in torch_spec:
                                accelerator = "cu121"
                            elif "+cu118" in torch_spec or "+cu11" in torch_spec:
                                accelerator = "cu118"
                            else:
                                accelerator = "cu121"
                        else:
                            accelerator = "cu121"
                    # Map to HF wheel index (cu121, cu118, cu124)
                    cu_tag = "cu121" if "cu121" in accelerator or (accelerator.startswith("cu12") and "cu124" not in accelerator) else ("cu124" if "cu124" in accelerator else "cu118")
                    hf_index = f"https://huggingface.github.io/autogptq-index/whl/{cu_tag}/"
                    log(f"Installing auto-gptq from pre-built CUDA wheels (index: {cu_tag})...")
                    # CRITICAL: never fall back to sdist/source builds (they require NVCC/torch-in-build-env and are fragile on Windows).
                    # If a wheel isn't available for this Python/CUDA combo, we want a fast, explicit failure we can handle upstream.
                    pip_cmd = [
                        str(python_exe), "-m", "pip", "install", "--upgrade",
                        "--only-binary", ":all:",
                        "--prefer-binary",
                        "auto-gptq",
                        "--extra-index-url", hf_index
                    ]
                    timeout_s = 600
                    # Uninstall first to avoid mixed source/wheel state
                    subprocess.run(
                        [str(python_exe), "-m", "pip", "uninstall", "-y", "auto-gptq", "auto_gptq"],
                        capture_output=True,
                        timeout=60,
                        **self.subprocess_flags
                    )

                result = subprocess.run(
                    pip_cmd,
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    env=env,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    log(f"Successfully installed {pkg}")
                    # GPTQ: verify CUDA kernels load (no "CUDA extension not installed" = crash path)
                    if pkg_norm.startswith("auto-gptq"):
                        verify_ok, verify_err = self._verify_autogptq_cuda_kernels(python_exe)
                        if not verify_ok:
                            pip_cmd_str = " ".join(str(x) for x in pip_cmd)
                            errors.append(
                                f"auto-gptq installed but CUDA kernels failed verification. "
                                f"Model startup would crash (0xC0000005).\n\n"
                                f"env_key: {env_key}\n"
                                f"pip_cmd: {pip_cmd_str}\n"
                                f"verify_error: {verify_err}"
                            )
                            return False, "\n\n".join(errors)
                        log("auto-gptq CUDA extension verified OK")
                else:
                    error_output = (result.stderr or result.stdout or "").strip()
                    # Persist full pip output for post-mortem debugging
                    full_log_path = None
                    try:
                        log_dir = self.env_manager.root_dir / "logs" / "pip_install"
                        log_dir.mkdir(parents=True, exist_ok=True)
                        full_log_path = log_dir / f"pip_install_{pkg_norm.replace('/', '_').replace(':','_')}_{uuid.uuid4().hex}.log"
                        full_log_path.write_text(error_output, encoding="utf-8", errors="replace")
                    except Exception:
                        full_log_path = None

                    # Keep UI logs readable but include a pointer to full output
                    truncated_error = error_output[:8000]
                    if full_log_path:
                        truncated_error = f"{truncated_error}\n\n[full pip output saved to]\n{full_log_path}"
                    # GPTQ: if no wheels exist for current Python (common on 3.12),
                    # recreate the env with Python 3.11 (if available) and retry.
                    if pkg_norm.startswith("auto-gptq") and (
                        "No matching distribution found for auto-gptq" in error_output
                        or "Could not find a version that satisfies the requirement auto-gptq" in error_output
                    ):
                        log("auto-gptq wheel not available for current Python. Attempting env rebuild with Python 3.11...")
                        profile = self._get_active_profile_data()
                        py311 = self._get_base_python_for_env(env_key, ["auto-gptq"], log_callback=log_callback)
                        if not py311:
                            py311 = self._find_windows_python("3.11", log_callback=log_callback)
                        if profile and py311:
                            try:
                                self._atomic_create_env(env_key, profile, log_callback=log_callback, base_python_exe=py311)
                                rebuilt_python = self._get_env_python_executable(env_key)
                                if not rebuilt_python or not rebuilt_python.exists():
                                    raise RuntimeError(f"Rebuilt env python not found: {rebuilt_python}")

                                # Retry wheel-only install in rebuilt env
                                retry_cmd = [
                                    str(rebuilt_python), "-m", "pip", "install", "--upgrade",
                                    "--only-binary", ":all:", "--prefer-binary",
                                    "auto-gptq", "--extra-index-url", hf_index
                                ]
                                retry = subprocess.run(
                                    retry_cmd,
                                    capture_output=True,
                                    text=True,
                                    timeout=600,
                                    **self.subprocess_flags
                                )
                                retry_out = (retry.stdout or "") + (retry.stderr or "")
                                if retry.returncode != 0:
                                    raise RuntimeError(retry_out.strip()[:8000])

                                verify_ok, verify_err = self._verify_autogptq_cuda_kernels(rebuilt_python)
                                if not verify_ok:
                                    raise RuntimeError(verify_err)

                                log("auto-gptq installed and verified after Python 3.11 env rebuild.")
                                return True, ""
                            except Exception as rebuild_err:
                                log(f"Python 3.11 rebuild+install failed: {rebuild_err}")
                                # fall through to standard error return below
                        else:
                            log("Python 3.11 not available (or profile missing); cannot rebuild env for auto-gptq wheels.")

                    log(f"Failed to install {pkg}: {truncated_error}")
                    errors.append(f"Package '{pkg}' failed:\n{truncated_error}")
                    return False, "\n\n".join(errors)
            except Exception as e:
                error_msg = f"Exception installing {pkg}: {str(e)}"
                log(error_msg)
                errors.append(error_msg)
                return False, "\n\n".join(errors)
        
        return True, ""
    
    def validate_env_spec(self, env_spec: EnvSpec) -> bool:
        """
        Validate an environment specification.
        
        Args:
            env_spec: The environment spec to validate
            
        Returns:
            True if valid, False otherwise
        """
        return (
            env_spec.python_executable.exists() and
            env_spec.python_executable.is_file()
        )
    
    def _derive_accelerator_from_profile(self, profile_data: Optional[dict]) -> str:
        """
        Derive accelerator from profile_data using priority order.
        Delegates to env_key_resolver's method for consistency.
        """
        return self.env_key_resolver._derive_accelerator(profile_data)
    
    def _is_env_compatible(self, env_key: str, req: dict, accelerator: str) -> bool:
        """
        Check if existing environment matches model requirements.
        
        Args:
            env_key: Environment key to check
            req: Model requirements dict from detect_model_requirements()
            accelerator: Accelerator string (e.g., "cu121")
        
        Returns:
            True if env can be used, False if needs different env
        """
        parsed = self.env_key_resolver.parse_env_key(env_key)
        
        # backend
        if req["backend_required"] == "llamacpp":
            return parsed["backend"] == "llamacpp"
        if parsed["backend"] != "tf":
            return False
        
        # accelerator (explicit, not from req)
        if parsed["accelerator"] != accelerator:
            return False
        
        # bnb requirement
        if req["needs_bnb"] and parsed.get("quant") != "bnb":
            return False
        if (not req["needs_bnb"]) and parsed.get("quant") == "bnb":
            # strict separation: don't reuse bnb env for base models
            return False
        
        # Compatibility check does not compare torch_mm (yet)
        # It only checks backend, accelerator, quant
        
        return True
