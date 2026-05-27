#!/usr/bin/env python3
"""
Environment Manager - Manages isolated Python environments per model
Each model gets its own environment with its own Python runtime and packages
"""

import sys
import subprocess
import shutil
from pathlib import Path
from typing import Optional, Dict, Tuple
import hashlib
import json
from datetime import datetime


class EnvironmentManager:
    """Manages per-model isolated Python environments"""
    
    def __init__(self, root_dir: Path = None):
        """
        Initialize environment manager.
        
        Args:
            root_dir: Root directory where environments/ will be created. Defaults to LLM directory.
        """
        if root_dir is None:
            root_dir = Path(__file__).parent.parent
        
        self.root_dir = Path(root_dir)
        self.environments_dir = self.root_dir / "environments"
        self.environments_dir.mkdir(exist_ok=True)
        
        # Windows subprocess flags
        self.subprocess_flags = {}
        if sys.platform == 'win32':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            self.subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }
    
    def _get_model_identifier(self, model_id: str = None, model_path: str = None) -> str:
        """
        Generate a unique identifier for a model.
        
        Args:
            model_id: HuggingFace model ID (e.g., "nvidia/Nemotron-3-30B")
            model_path: Local model path
            
        Returns:
            Unique identifier string safe for filesystem
        """
        if model_id:
            # Use model_id as base, sanitize for filesystem
            identifier = model_id.replace("/", "__").replace("\\", "__")
            identifier = "".join(c for c in identifier if c.isalnum() or c in ("_", "-", "."))
            return identifier
        elif model_path:
            # Use path hash for local models
            path_str = str(Path(model_path).resolve())
            hash_obj = hashlib.md5(path_str.encode())
            return f"local_{hash_obj.hexdigest()[:12]}"
        else:
            raise ValueError("Either model_id or model_path must be provided")
    
    def get_environment_path(self, model_id: str = None, model_path: str = None) -> Path:
        """
        Get the environment path for a model.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            
        Returns:
            Path to the model's environment directory
        """
        identifier = self._get_model_identifier(model_id, model_path)
        return self.environments_dir / identifier
    
    def get_python_executable(self, model_id: str = None, model_path: str = None) -> Optional[Path]:
        """
        Get the Python executable for a model's environment.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            
        Returns:
            Path to Python executable, or None if environment doesn't exist
        """
        env_path = self.get_environment_path(model_id, model_path)
        if sys.platform == 'win32':
            python_exe = env_path / ".venv" / "Scripts" / "python.exe"
        else:
            python_exe = env_path / ".venv" / "bin" / "python"
        
        return python_exe if python_exe.exists() else None
    
    def environment_exists(self, model_id: str = None, model_path: str = None) -> bool:
        """Check if environment exists for a model"""
        python_exe = self.get_python_executable(model_id, model_path)
        return python_exe is not None and python_exe.exists()
    
    def create_environment(
        self, 
        model_id: str = None, 
        model_path: str = None,
        python_runtime: Path = None,
        profile_name: str = None
    ) -> Tuple[bool, str]:
        """
        Create an isolated environment for a model.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            python_runtime: Path to self-contained Python runtime (if None, uses system Python)
            profile_name: Hardware profile name (e.g., "cuda121_ampere")
            
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        env_path = self.get_environment_path(model_id, model_path)
        venv_path = env_path / ".venv"
        
        # Use self-contained Python runtime if provided, otherwise system Python
        if python_runtime and python_runtime.exists():
            python_exe = python_runtime
        else:
            python_exe = Path(sys.executable)
        
        try:
            # Create venv
            result = subprocess.run(
                [str(python_exe), "-m", "venv", str(venv_path), "--clear"],
                capture_output=True,
                text=True,
                timeout=120,
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                return False, f"Failed to create venv: {result.stderr}"
            
            # Get venv Python path
            if sys.platform == 'win32':
                venv_python = venv_path / "Scripts" / "python.exe"
            else:
                venv_python = venv_path / "bin" / "python"
            
            if not venv_python.exists():
                return False, f"Venv created but Python not found at {venv_python}"

            # Install the Windows subprocess-guard bootstrap into this venv so
            # its python.exe auto-suppresses console windows for grandchildren
            # (pip build workers, setup.py compilers, etc). See root-cause note
            # in core/win_subprocess_guard.py::install_guard_into_venv.
            try:
                from core.win_subprocess_guard import install_guard_into_venv
                install_guard_into_venv(str(venv_path))
            except Exception:
                pass

            # Get Python version for metadata
            python_version = None
            try:
                result = subprocess.run(
                    [str(venv_python), "--version"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    version_str = result.stdout.strip()
                    if "Python " in version_str:
                        python_version = version_str.split("Python ")[1]
            except Exception:
                pass
            
            # Install base packages (essential for ML)
            print(f"Installing base packages in environment...")
            # Keep base environment creation lightweight and deterministic.
            # The active hardware profile (LLM/profiles/*.json) is the single source of truth
            # for torch (+cuXXX) and other heavy packages; EnvRegistry will install them.
            base_packages = ["pip", "setuptools", "wheel"]
            
            try:
                # Upgrade pip first
                subprocess.run(
                    [str(venv_python), "-m", "pip", "install", "--upgrade", "pip"],
                    capture_output=True,
                    timeout=120,
                    **self.subprocess_flags
                )
                
                # Install base packages
                subprocess.run(
                    [str(venv_python), "-m", "pip", "install"] + base_packages,
                    capture_output=True,
                    timeout=600,  # 10 minutes for package installation
                    **self.subprocess_flags
                )
            except Exception as e:
                print(f"Warning: Failed to install some packages: {e}")
            
            # Count installed packages
            package_count = 0
            try:
                result = subprocess.run(
                    [str(venv_python), "-m", "pip", "list", "--format=freeze"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    packages = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
                    package_count = len(packages)
            except Exception:
                pass
            
            # Store metadata about this environment
            metadata = {
                "model_id": model_id,
                "model_path": model_path,
                "profile_name": profile_name,
                "python_runtime": str(python_runtime) if python_runtime else None,
                "python_version": python_version,
                "created_at": datetime.now().isoformat(),
                "associated_models": [],
                "package_count": package_count,
                "base_packages": base_packages
            }
            metadata_file = env_path / "environment_metadata.json"
            with open(metadata_file, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2)
            
            return True, ""
            
        except Exception as e:
            return False, str(e)
    
    def create_environment_with_logging(
        self,
        model_id: str = None,
        model_path: str = None,
        python_runtime: Path = None,
        profile_name: str = None,
        log_callback=None
    ) -> Tuple[bool, str]:
        """
        Create an isolated environment with real-time logging.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            python_runtime: Path to self-contained Python runtime
            profile_name: Hardware profile name
            log_callback: Function to call with log messages
            
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
            # Remove emojis for Windows console compatibility
            try:
                print(msg)
            except UnicodeEncodeError:
                # Fallback: strip non-ascii characters
                safe_msg = msg.encode('ascii', errors='ignore').decode('ascii')
                print(safe_msg)
        
        env_path = self.get_environment_path(model_id, model_path)
        venv_path = env_path / ".venv"
        
        # Use self-contained Python runtime if provided, otherwise system Python
        if python_runtime and python_runtime.exists():
            python_exe = python_runtime
        else:
            python_exe = Path(sys.executable)
        
        log(f"📍 Environment path: {env_path}")
        log(f"🐍 Using Python: {python_exe}")
        
        try:
            # Create venv
            log("⏳ Creating virtual environment...")
            result = subprocess.run(
                [str(python_exe), "-m", "venv", str(venv_path), "--clear"],
                capture_output=True,
                text=True,
                timeout=120,
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                log(f"❌ Venv creation failed!")
                return False, f"Failed to create venv: {result.stderr}"
            
            log("✅ Virtual environment created")
            
            # Get venv Python path
            if sys.platform == 'win32':
                venv_python = venv_path / "Scripts" / "python.exe"
            else:
                venv_python = venv_path / "bin" / "python"
            
            if not venv_python.exists():
                return False, f"Venv created but Python not found at {venv_python}"

            try:
                from core.win_subprocess_guard import install_guard_into_venv
                install_guard_into_venv(str(venv_path))
            except Exception:
                pass

            log(f"🔍 Venv Python: {venv_python}")
            
            # Get Python version
            log("🔍 Detecting Python version...")
            python_version = None
            try:
                result = subprocess.run(
                    [str(venv_python), "--version"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    version_str = result.stdout.strip()
                    if "Python " in version_str:
                        python_version = version_str.split("Python ")[1]
                        log(f"✅ Python version: {python_version}")
            except Exception:
                pass
            
            # Upgrade pip first
            log("⬆️ Upgrading pip...")
            try:
                result = subprocess.run(
                    [str(venv_python), "-m", "pip", "install", "--upgrade", "pip"],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    log("✅ Pip upgraded")
                else:
                    log(f"⚠️ Pip upgrade had issues: {result.stderr[:200]}")
            except Exception as e:
                log(f"⚠️ Pip upgrade failed: {e}")
            
            # Install base packages
            log("📦 Installing base packages...")
            base_packages = [
                "setuptools",
                "wheel",
                "torch",
                "transformers",
                "accelerate",
                "safetensors",
                "huggingface-hub"
            ]
            
            for pkg in base_packages:
                log(f"  ⏳ Installing {pkg}...")
                try:
                    result = subprocess.run(
                        [str(venv_python), "-m", "pip", "install", pkg],
                        capture_output=True,
                        text=True,
                        timeout=600,  # 10 minutes per package
                        **self.subprocess_flags
                    )
                    if result.returncode == 0:
                        log(f"  ✅ {pkg} installed")
                    else:
                        log(f"  ⚠️ {pkg} had issues: {result.stderr[:200]}")
                except Exception as e:
                    log(f"  ❌ {pkg} failed: {e}")
            
            # Count installed packages
            log("📊 Counting installed packages...")
            package_count = 0
            try:
                result = subprocess.run(
                    [str(venv_python), "-m", "pip", "list", "--format=freeze"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    packages = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
                    package_count = len(packages)
                    log(f"✅ Total packages: {package_count}")
            except Exception:
                pass
            
            # Store metadata
            log("💾 Saving environment metadata...")
            metadata = {
                "model_id": model_id,
                "model_path": model_path,
                "profile_name": profile_name,
                "python_runtime": str(python_runtime) if python_runtime else None,
                "python_version": python_version,
                "created_at": datetime.now().isoformat(),
                "associated_models": [],
                "package_count": package_count,
                "base_packages": base_packages
            }
            metadata_file = env_path / "environment_metadata.json"
            with open(metadata_file, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2)
            
            log("✅ Metadata saved")
            
            return True, ""
            
        except Exception as e:
            log(f"❌ FATAL ERROR: {str(e)}")
            return False, str(e)
    
    def delete_environment(self, model_id: str = None, model_path: str = None) -> bool:
        """
        Delete a model's environment.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            
        Returns:
            True if successful, False otherwise
        """
        env_path = self.get_environment_path(model_id, model_path)
        if env_path.exists():
            try:
                shutil.rmtree(env_path)
                return True
            except Exception:
                return False
        return True
    
    def list_environments(self) -> Dict[str, Dict]:
        """
        List all existing environments.
        
        Returns:
            Dict mapping environment identifier to metadata
        """
        environments = {}
        for env_dir in self.environments_dir.iterdir():
            if not env_dir.is_dir():
                continue
            
            metadata_file = env_dir / "environment_metadata.json"
            if metadata_file.exists():
                try:
                    with open(metadata_file, 'r', encoding='utf-8') as f:
                        metadata = json.load(f)
                    environments[env_dir.name] = metadata
                except Exception:
                    pass
        
        return environments
    
    def get_environment_info(self, model_id: str = None, model_path: str = None) -> Optional[Dict]:
        """
        Get detailed information about an environment.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            
        Returns:
            Dict with environment details, or None if not found
        """
        env_path = self.get_environment_path(model_id, model_path)
        if not env_path.exists():
            return None
        
        info = {
            "env_id": env_path.name,
            "path": str(env_path),
            "exists": True,
            "python_version": None,
            "package_count": 0,
            "disk_usage_mb": 0,
            "associated_models": [],
            "created_at": None,
            "last_updated": None,
        }
        
        # Get Python version
        python_exe = self.get_python_executable(model_id, model_path)
        if python_exe and python_exe.exists():
            try:
                result = subprocess.run(
                    [str(python_exe), "--version"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    # Parse "Python 3.12.1" -> "3.12.1"
                    version_str = result.stdout.strip()
                    if "Python " in version_str:
                        info["python_version"] = version_str.split("Python ")[1]
                    else:
                        info["python_version"] = version_str
            except Exception:
                pass
        
        # Calculate disk usage
        try:
            total_size = sum(f.stat().st_size for f in env_path.rglob('*') if f.is_file())
            info["disk_usage_mb"] = round(total_size / (1024 * 1024), 1)
        except Exception:
            pass
        
        # Count packages
        try:
            packages = self.get_environment_packages(model_id, model_path)
            info["package_count"] = len(packages)
        except Exception:
            pass
        
        # Load metadata
        metadata_file = env_path / "environment_metadata.json"
        if metadata_file.exists():
            try:
                with open(metadata_file, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                    info["associated_models"] = metadata.get("associated_models", [])
                    info["created_at"] = metadata.get("created_at")
                    info["last_updated"] = metadata.get("last_updated")
                    info["hardware_profile"] = metadata.get("hardware_profile")
                    info["notes"] = metadata.get("notes", "")
            except Exception:
                pass
        
        return info
    
    def get_environment_packages(self, model_id: str = None, model_path: str = None) -> list[str]:
        """
        Get list of installed packages in an environment.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            
        Returns:
            List of package names (format: "package==version")
        """
        python_exe = self.get_python_executable(model_id, model_path)
        if not python_exe or not python_exe.exists():
            return []
        
        try:
            result = subprocess.run(
                [str(python_exe), "-m", "pip", "list", "--format=freeze"],
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            if result.returncode == 0:
                # Parse pip freeze output
                packages = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
                return packages
        except Exception:
            pass
        
        return []
    
    def get_associated_environment(self, model_path: str) -> Optional[str]:
        """
        Find which environment is associated with a model path.
        
        Args:
            model_path: Local model path
            
        Returns:
            Environment ID if found, None otherwise
        """
        model_path_normalized = str(Path(model_path).resolve())
        
        # Check all environments
        for env_dir in self.environments_dir.iterdir():
            if not env_dir.is_dir():
                continue
            
            metadata_file = env_dir / "environment_metadata.json"
            if metadata_file.exists():
                try:
                    with open(metadata_file, 'r', encoding='utf-8') as f:
                        metadata = json.load(f)
                        associated = metadata.get("associated_models", [])
                        for assoc_model in associated:
                            # Check if the associated model matches (by path or ID)
                            if model_path_normalized in assoc_model or assoc_model in model_path_normalized:
                                return env_dir.name
                except Exception:
                    pass
        
        return None
    
    def associate_model(self, env_id: str, model_path_or_id: str) -> bool:
        """
        Associate a model with an environment.
        
        Args:
            env_id: Environment identifier
            model_path_or_id: Model path or HuggingFace ID
            
        Returns:
            True if successful
        """
        env_path = self.environments_dir / env_id
        if not env_path.exists():
            return False
        
        metadata_file = env_path / "environment_metadata.json"
        
        # Load existing metadata or create new
        metadata = {}
        if metadata_file.exists():
            try:
                with open(metadata_file, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
            except Exception:
                pass
        
        # Add model to associated_models list
        associated = metadata.get("associated_models", [])
        if model_path_or_id not in associated:
            associated.append(model_path_or_id)
        metadata["associated_models"] = associated
        metadata["last_updated"] = datetime.now().isoformat()
        
        # Save metadata
        try:
            with open(metadata_file, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2)
            return True
        except Exception:
            return False
    
    def disassociate_model(self, env_id: str, model_path_or_id: str) -> bool:
        """
        Remove model association from an environment.
        
        Args:
            env_id: Environment identifier
            model_path_or_id: Model path or HuggingFace ID
            
        Returns:
            True if successful
        """
        env_path = self.environments_dir / env_id
        if not env_path.exists():
            return False
        
        metadata_file = env_path / "environment_metadata.json"
        if not metadata_file.exists():
            return False
        
        try:
            with open(metadata_file, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
            
            associated = metadata.get("associated_models", [])
            if model_path_or_id in associated:
                associated.remove(model_path_or_id)
            metadata["associated_models"] = associated
            metadata["last_updated"] = datetime.now().isoformat()
            
            with open(metadata_file, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2)
            return True
        except Exception:
            return False
    
    def list_all_environments(self) -> list[Dict]:
        """
        List all environments with basic info (fast, no heavy operations).
        
        Returns:
            List of environment info dicts
        """
        envs = []
        
        # Quick check: does directory exist and is readable?
        if not self.environments_dir.exists():
            return envs
        
        try:
            # Get immediate children only (fast)
            dir_list = list(self.environments_dir.iterdir())
        except Exception:
            return envs
        
        # Quick check if empty
        if not dir_list:
            return envs
        
        for env_dir in dir_list:
            try:
                if not env_dir.is_dir():
                    continue
                
                venv_path = env_dir / ".venv"
                if not venv_path.exists():
                    continue
                
                # Get basic info (lightweight)
                info = {
                    "env_id": env_dir.name,
                    "path": str(env_dir),
                    "python_version": "Unknown",
                    "package_count": 0,
                    "disk_usage_mb": 0,
                }
                
                # Load metadata first (fast file read)
                metadata_file = env_dir / "environment_metadata.json"
                if metadata_file.exists():
                    try:
                        with open(metadata_file, 'r', encoding='utf-8') as f:
                            metadata = json.load(f)
                            info["associated_models"] = metadata.get("associated_models", [])
                            info["created_at"] = metadata.get("created_at")
                            info["package_count"] = metadata.get("package_count", 0)
                            # Use cached python version from metadata if available
                            if "python_version" in metadata:
                                info["python_version"] = metadata["python_version"]
                    except Exception:
                        pass
                
                envs.append(info)
            except Exception:
                continue
        
        return envs

