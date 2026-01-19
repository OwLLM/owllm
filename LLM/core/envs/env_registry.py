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

    def _get_active_profile_data(self) -> Optional[dict]:
        """Get active hardware profile data (delegates to resolver)"""
        return self.env_key_resolver.get_active_profile_data()
    
    def _atomic_create_env(
        self,
        env_key: str,
        profile_data: dict,
        log_callback=None
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
            
            # Create venv
            venv_path = tmp_dir / ".venv"
            result = subprocess.run(
                [sys.executable, "-m", "venv", str(venv_path), "--clear"],
                capture_output=True,
                text=True,
                timeout=120,
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                raise RuntimeError(f"Failed to create venv: {result.stderr}")
            
            # Get Python executable
            if sys.platform == 'win32':
                python_exe = venv_path / "Scripts" / "python.exe"
            else:
                python_exe = venv_path / "bin" / "python"
            
            if not python_exe.exists():
                raise RuntimeError(f"Python executable not found after venv creation: {python_exe}")
            
            log(f"Virtual environment created, installing dependencies...")
            
            # Install base packages
            log("Installing pip, setuptools, wheel...")
            subprocess.run(
                [str(python_exe), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel", "-q"],
                capture_output=True,
                text=True,
                timeout=300,
                **self.subprocess_flags
            )
            
            # Install server framework
            log("Installing server framework...")
            subprocess.run(
                [str(python_exe), "-m", "pip", "install",
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
            self._install_inference_stack(python_exe, profile_data, log_callback=log_callback)
            
            # Health check
            log("Running health checks...")
            if not self._health_check_env(python_exe, profile_data):
                raise RuntimeError("Environment health check failed")
            
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

    def _health_check_env(self, python_exe: Path, profile_data: Optional[dict]) -> bool:
        """
        Run health checks on environment.
        
        Args:
            python_exe: Python executable path
            profile_data: Hardware profile data
        
        Returns:
            True if all checks pass
        """
        try:
            # Check basic imports
            code = "import uvicorn, fastapi, transformers, peft, torch, accelerate, bitsandbytes\n"
            
            # If CUDA profile, verify CUDA is available
            if profile_data:
                torch_spec = str(profile_data.get("packages", {}).get("torch", ""))
                torch_index = str(profile_data.get("torch_index", ""))
                require_cuda = ("+cu" in torch_spec) or ("/whl/cu" in torch_index)
                
                if require_cuda:
                    code += "assert torch.cuda.is_available(), 'CUDA not available'\n"
                    code += "assert '+cu' in torch.__version__, 'CPU torch detected in CUDA env'\n"
            
            code += "print('OK')"
            
            result = self._run_python(python_exe, code, timeout=30)
            return result.returncode == 0 and "OK" in result.stdout
        except Exception:
            return False
    
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
    
    def _install_inference_stack(self, python_exe: Path, profile_data: dict, log_callback=None):
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
        
        minimal_specs = [
            _pkg("numpy", "numpy==1.26.4"),
            _pkg("huggingface-hub", None),
            "transformers==4.51.3",
            "tokenizers==0.21.4",
            "protobuf",
            _pkg("safetensors", "safetensors>=0.7.0,<0.8.0"),
            _pkg("accelerate", "accelerate>=1.2.0,<1.3.0"),
            _pkg("peft", "peft>=0.13.0,<0.16.0"),
            _pkg("bitsandbytes", "bitsandbytes>=0.45.0,<0.50.0"),
            _pkg("sentencepiece", "sentencepiece==0.2.0"),
            _pkg("pyyaml", "pyyaml>=6.0.0,<7.0.0"),
            _pkg("requests", "requests>=2.31.0,<3.0.0"),
        ]
        minimal_specs = [s for s in minimal_specs if s]
        
        for spec in minimal_specs:
            log(f"Installing {spec}...")
            r = subprocess.run(
                [str(python_exe), "-m", "pip", "install", "--upgrade", spec],
                capture_output=True,
                text=True,
                timeout=1800,
                **self.subprocess_flags
            )
            if r.returncode != 0:
                err = (r.stderr or r.stdout or "").strip()
                log(f"Warning: Failed to install {spec}: {err[:500]}")

    def _run_python(self, python_exe: Path, code: str, timeout: int = 30) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str(python_exe), "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
            **self.subprocess_flags
        )

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

        # Uninstall any existing stack first (avoid mixed CPU/CUDA wheels)
        for pkg in ["torch", "torchvision", "torchaudio", "xformers", "triton", "triton-windows"]:
            try:
                subprocess.run(
                    [str(python_exe), "-m", "pip", "uninstall", "-y", pkg],
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
                    str(python_exe),
                    "-m",
                    "pip",
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
            code = "import torch, transformers, peft, accelerate\n"
            
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
        
        # Resolve env_key from model requirements
        # TODO: Parse model config to determine backend/quantization
        # For now, use transformers + quantization as default
        env_key = self.env_key_resolver.resolve_env_key(
            backend="transformers",
            use_quantization=True,
            model_path=model_path,
            profile_data=profile_data
        )
        
        log(f"Resolved env_key: {env_key}")
        
        # STRATEGY 1: Check for existing new shared environment
        env_state = self.state_store.get_env(env_key)
        python_exe = self._get_env_python_executable(env_key)
        
        if python_exe and python_exe.exists() and env_state and env_state['status'] == 'READY':
            # Verify health
            if self._health_check_env(python_exe, profile_data):
                log(f"Using existing shared environment: {env_key}")
                return EnvSpec(
                    key=env_key,
                    python_executable=python_exe,
                    metadata={"env_key": env_key, "status": "READY", "source": "shared"}
                )
            else:
                log(f"Existing shared environment {env_key} failed health check")
        
        # STRATEGY 2: Fallback to old per-model environment (MIGRATION PATH)
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
        
        # STRATEGY 3: Check for ongoing creation (idempotency)
        if env_state and env_state['status'] == 'CREATING':
            raise RuntimeError(
                f"Environment {env_key} is already being created. "
                f"Please wait for the other creation to complete."
            )
        
        # STRATEGY 4: Create new shared environment
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
    
    def auto_install_missing_packages(self, python_exe: Path, packages: list, log_callback=None) -> bool:
        """
        Automatically install missing packages in the environment.
        
        Args:
            python_exe: Path to Python executable
            packages: List of package names to install
            log_callback: Optional callback for logging
            
        Returns:
            True if all packages installed successfully, False otherwise
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
        
        for pkg in packages:
            log(f"Installing missing package: {pkg}...")
            try:
                result = subprocess.run(
                    [str(python_exe), "-m", "pip", "install", pkg],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    log(f"Successfully installed {pkg}")
                else:
                    error_output = (result.stderr or result.stdout or "").strip()
                    log(f"Failed to install {pkg}: {error_output[:200]}")
                    return False
            except Exception as e:
                log(f"Error installing {pkg}: {e}")
                return False
        
        return True
    
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
