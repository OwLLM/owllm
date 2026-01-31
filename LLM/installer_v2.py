#!/usr/bin/env python3
"""
Installer V2 - Main Coordinator
Immutable installer for LLM Fine-tuning Studio
"""

import sys
import os
import json
import subprocess
import shutil
from pathlib import Path
from typing import Tuple

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from core.wheelhouse import WheelhouseManager
from core.immutable_installer import ImmutableInstaller, InstallationFailed
from system_detector import SystemDetector
from core.python_runtime import PythonRuntimeManager
from core.environment_manager import EnvironmentManager
from core.envs.env_key_resolver import encode_torch_mm


class InstallerV2:
    """
    Main installer coordinator for immutable installation.
    Orchestrates detection, wheel download, and atomic installation.
    """
    
    def __init__(self, root_dir: Path = None):
        """Initialize installer coordinator
        
        Args:
            root_dir: Root directory containing .venv, metadata, etc. Defaults to script directory.
        """
        self.root = root_dir if root_dir else Path(__file__).parent
        self.manifest_path = self.root / "metadata" / "dependencies.json"
        self.compat_matrix_path = self.root / "metadata" / "compatibility_matrix.json"
        self.wheelhouse = self.root / "wheelhouse"
        self.venv = self.root / ".venv"
        # Shared env-key environments live here (preferred over LLM/.venv).
        self.envs_dir = self.root / ".envs"
        self.envs_dir.mkdir(exist_ok=True)
        
        # Initialize Python runtime manager for self-contained Python
        self.python_runtime_manager = PythonRuntimeManager(self.root)
        
        # Initialize environment manager for per-model isolated environments
        self.env_manager = EnvironmentManager(self.root)
        
        # Verify manifest exists and load it
        if not self.manifest_path.exists():
            raise FileNotFoundError(f"Manifest not found: {self.manifest_path}")
        
        with open(self.manifest_path) as f:
            self.manifest = json.load(f)
        
        # Check if compatibility matrix exists (for hardware-adaptive mode)
        self.use_adaptive = self.compat_matrix_path.exists()
        if not self.use_adaptive:
            self.log("⚠ Compatibility matrix not found. Using legacy fixed-version mode.")

    def _derive_env_key(self, package_versions: dict, tier: str = "stable", quant: str = "base") -> str:
        """
        Derive shared environment key from selected profile/package versions.
        Format aligns with EnvKeyResolver: tf-<accelerator>-t<mm>-<quant>-<tier>
        """
        torch_spec = str((package_versions or {}).get("torch", "")).strip()
        accelerator = "cpu"
        if "+cu" in torch_spec:
            # torch looks like 2.5.1+cu124
            try:
                cuda_part = torch_spec.split("+cu", 1)[1]
                digits = "".join([c for c in cuda_part if c.isdigit()])[:3]
                if digits:
                    accelerator = f"cu{digits}"
            except Exception:
                accelerator = "cpu"

        # Torch major.minor for env key encoding
        torch_mm = ""
        if torch_spec:
            base = torch_spec.split("+", 1)[0]
            parts = base.split(".")
            if len(parts) >= 2:
                torch_mm = f"{parts[0]}.{parts[1]}"
        t_enc = encode_torch_mm(torch_mm) if torch_mm else ""

        if t_enc:
            return f"tf-{accelerator}-t{t_enc}-{quant}-{tier}"
        return f"tf-{accelerator}-{quant}-{tier}"

    def _get_env_paths(self, env_key: str) -> Tuple[Path, Path, Path]:
        """
        Return (venv_path, wheelhouse_path, env_state_dir) for an env_key.
        - venv_path: LLM/.envs/<env_key>/.venv
        - wheelhouse_path: LLM/wheelhouse/<env_key>
        - env_state_dir: LLM/.envs/<env_key> (state files live alongside venv)
        """
        env_dir = self.envs_dir / env_key
        venv_path = env_dir / ".venv"
        wheelhouse_path = self.wheelhouse / env_key
        return venv_path, wheelhouse_path, env_dir

    def _maybe_migrate_legacy_layout(self, env_key: str, venv_path: Path, wheelhouse_path: Path) -> None:
        """
        One-time migration helper:
        - If legacy LLM/.venv exists but env_key venv doesn't, move it to LLM/.envs/<env_key>/.venv
          and create a compatibility junction/symlink back at LLM/.venv.
        - If legacy wheelhouse has wheels at LLM/wheelhouse/*.whl but env_key wheelhouse is empty,
          seed LLM/wheelhouse/<env_key>/ with hardlinks (or copies) so we don't re-download.
        """
        try:
            env_dir = venv_path.parent
            env_dir.mkdir(parents=True, exist_ok=True)

            # Migrate legacy venv -> env_key venv
            if not venv_path.exists() and self.venv.exists():
                self.log(f"\n[MIGRATE] Moving legacy venv to env_key: {env_key}")
                self.log(f"[MIGRATE]  From: {self.venv}")
                self.log(f"[MIGRATE]  To:   {venv_path}")
                try:
                    shutil.move(str(self.venv), str(venv_path))
                except Exception as e:
                    self.log(f"[MIGRATE]  ⚠ Could not move legacy venv: {e}")
                else:
                    # Create compatibility link/junction so older code paths still work.
                    try:
                        if sys.platform == "win32":
                            # Junctions usually work without admin (unlike symlinks).
                            subprocess.run(
                                ["cmd", "/c", "mklink", "/J", str(self.venv), str(venv_path)],
                                capture_output=True,
                                text=True,
                                timeout=30
                            )
                        else:
                            os.symlink(str(venv_path), str(self.venv))
                        self.log(f"[MIGRATE]  ✓ Created compatibility link: {self.venv} -> {venv_path}")
                    except Exception as e:
                        self.log(f"[MIGRATE]  ⚠ Could not create compatibility link: {e}")

            # Seed per-env wheelhouse from legacy wheelhouse wheels
            try:
                legacy_wheels = list(self.wheelhouse.glob("*.whl"))
            except Exception:
                legacy_wheels = []
            if legacy_wheels:
                wheelhouse_path.mkdir(parents=True, exist_ok=True)
                existing = list(wheelhouse_path.glob("*.whl"))
                if not existing:
                    self.log(f"\n[MIGRATE] Seeding wheelhouse cache for env_key: {env_key}")
                    self.log(f"[MIGRATE]  From: {self.wheelhouse}/*.whl ({len(legacy_wheels)} wheels)")
                    self.log(f"[MIGRATE]  To:   {wheelhouse_path}")
                    linked = 0
                    copied = 0
                    for src in legacy_wheels:
                        dst = wheelhouse_path / src.name
                        if dst.exists():
                            continue
                        try:
                            os.link(src, dst)
                            linked += 1
                        except Exception:
                            try:
                                shutil.copy2(src, dst)
                                copied += 1
                            except Exception:
                                continue
                    self.log(f"[MIGRATE]  ✓ Seeded wheelhouse: {linked} hardlinked, {copied} copied")
        except Exception:
            # Never fail install/repair due to migration issues.
            return
    
    def log(self, message: str):
        """Log message to console with encoding safety"""
        try:
            print(f"[INSTALLER-V2] {message}")
        except UnicodeEncodeError:
            # Fallback for Windows consoles that don't support UTF-8 characters
            safe_message = message.replace('✓', '[OK]').replace('✗', '[FAIL]').replace('⚠', '[WARN]').replace('🎯', '[TARGET]')
            try:
                print(f"[INSTALLER-V2] {safe_message}")
            except Exception:
                pass # Give up if even safe message fails
    
    def install(self, skip_wheelhouse: bool = False, allow_destroy: bool = False) -> bool:
        """
        Run full installation.
        
        Args:
            skip_wheelhouse: If True, skip wheelhouse preparation (use existing)
            allow_destroy: If True, allows deletion of existing .venv if corrupted
        
        Returns:
            True if successful, False otherwise
        """
        try:
            self.log("=" * 60)
            self.log("LLM Fine-tuning Studio - Immutable Installer v2.0")
            self.log("=" * 60)
            
            # PHASE 0: Detection
            self.log("\nPHASE 0: Hardware and Platform Detection")
            self.log("-" * 60)
            
            detector = SystemDetector()
            results = detector.detect_all()
            
            # Display detection results
            self._display_detection_results(results)
            
            # Check for self-contained Python runtime first
            self.log("\nChecking for self-contained Python runtime...")
            python_runtime = self.python_runtime_manager.get_python_runtime("3.12")
            
            if python_runtime:
                self.log(f"✓ Using self-contained Python runtime: {python_runtime}")
                # Use self-contained Python for venv creation
                self._python_executable = python_runtime
            else:
                # Fallback to system Python, but validate version
                self.log("⚠ Self-contained Python runtime not available, using system Python")
                python_version = (sys.version_info.major, sys.version_info.minor)
                min_py = tuple(map(int, self.manifest["python_min"].split('.')))
                max_py = tuple(map(int, self.manifest["python_max"].split('.')))
                
                if python_version < min_py or python_version > max_py:
                    # Try to download self-contained Python
                    self.log(f"System Python {python_version[0]}.{python_version[1]} not supported.")
                    self.log("Attempting to download self-contained Python runtime...")
                    python_runtime = self.python_runtime_manager.get_python_runtime("3.12")
                    if python_runtime:
                        self.log(f"✓ Downloaded and using self-contained Python: {python_runtime}")
                        self._python_executable = python_runtime
                    else:
                        raise ValueError(
                            f"\n✗ Python {python_version[0]}.{python_version[1]} is not supported.\n"
                            f"  Required: Python {self.manifest['python_min']} - {self.manifest['python_max']}\n"
                            f"  Current: Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}\n\n"
                            f"  Failed to download self-contained Python runtime.\n"
                            f"  Please install Python 3.10, 3.11, or 3.12 from:\n"
                            f"  https://www.python.org/downloads/"
                        )
                else:
                    self._python_executable = sys.executable
            
            # Hardware-adaptive mode: Use ProfileSelector
            if self.use_adaptive:
                self.log("\n🎯 Using hardware-adaptive installation")
                
                from core.profile_selector import ProfileSelector
                from setup_state import SetupStateManager
                
                # Get hardware profile (with user-selected GPU if any)
                setup_state = SetupStateManager()
                selected_gpu_index = setup_state.get_selected_gpu_index()
                hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)
                
                # Select optimal profile (with user override if any)
                selector = ProfileSelector(self.compat_matrix_path)
                override_profile = setup_state.get_selected_profile()
                try:
                    profile_name, package_versions, warnings, binary_packages = selector.select_profile(
                        hw_profile, override_profile_id=override_profile
                    )
                    
                    self.log(f"\n✓ Selected profile: {profile_name}")
                    self.log(f"  {selector.get_profile_description(profile_name)}")
                    
                    for warning in warnings:
                        self.log(f"  ⚠ {warning}")
                    
                    # Determine CUDA config from selected profile
                    cuda_config = self._extract_cuda_config(package_versions.get("torch", ""))
                    env_key = self._derive_env_key(package_versions)
                    venv_path, wheelhouse_path, _env_dir = self._get_env_paths(env_key)
                    self.log(f"✓ Target env_key: {env_key}")
                    self.log(f"  Venv path: {venv_path}")
                    self.log(f"  Wheelhouse path: {wheelhouse_path}")
                    # If user is upgrading from legacy single-env layout, migrate once to avoid re-download/reinstall.
                    self._maybe_migrate_legacy_layout(env_key, venv_path, wheelhouse_path)
                    
                except Exception as e:
                    raise ValueError(f"Profile selection failed: {str(e)}")
            
            # Legacy mode: Use fixed versions from manifest
            else:
                self.log("\n⚠ Using legacy fixed-version installation")
                cuda_config = self._determine_cuda_config(results)
                package_versions = None  # Will use manifest
                binary_packages = None  # No binary packages in legacy mode
                # Legacy mode keeps shared env layout
                env_key = None
                venv_path = self.venv
                wheelhouse_path = self.wheelhouse
            
            self.log(f"\n✓ Target configuration: {cuda_config}")
            
            # PHASE 1: Prepare wheelhouse (unless skipped)
            if not skip_wheelhouse:
                self.log("\nPHASE 1: Wheelhouse Preparation")
                self.log("-" * 60)
                self.log(f"  Wheelhouse path: {wheelhouse_path}")
                
                wheelhouse_mgr = WheelhouseManager(self.manifest_path, wheelhouse_path)
                # Route wheelhouse logs to GUI
                wheelhouse_mgr.log = self.log

                python_version = (sys.version_info.major, sys.version_info.minor)
                success, error = wheelhouse_mgr.prepare_wheelhouse(
                    cuda_config, 
                    python_version,
                    package_versions,  # Pass hardware-specific versions or None
                    binary_packages if self.use_adaptive else None  # Pass binary packages if using profile
                )
                
                if not success:
                    self.log(f"\n✗ Wheelhouse preparation failed:")
                    self.log(f"  {error}")
                    return False
                
                self.log("\n✓ Wheelhouse ready")
            else:
                self.log("\nPHASE 1: Wheelhouse Preparation (SKIPPED)")
                self.log(f"  Using existing wheelhouse at: {wheelhouse_path}")
                
                if not wheelhouse_path.exists():
                    self.log("\n✗ Wheelhouse directory not found!")
                    return False
                
                wheel_count = len(list(wheelhouse_path.glob("*.whl")))
                if wheel_count == 0:
                    self.log("\n✗ Wheelhouse is empty!")
                    return False
                
                self.log(f"  ✓ Found {wheel_count} wheels")
            
            # PHASE 2-6: Install
            self.log("\nPHASE 2-6: Environment Installation")
            self.log("-" * 60)
            
            # Use self-contained Python if available, otherwise use sys.executable
            python_exe = getattr(self, '_python_executable', None)
            if python_exe:
                python_exe = Path(python_exe)
            else:
                python_exe = None
            
            installer = ImmutableInstaller(venv_path, wheelhouse_path, self.manifest_path, python_executable=python_exe)
            # Route installer logs to GUI
            installer.log = self.log

            success, error = installer.install(cuda_config, package_versions=package_versions, binary_packages=binary_packages if self.use_adaptive else None, allow_destroy=allow_destroy)
            
            if not success:
                self.log(f"\n✗ Installation failed:")
                self.log(f"  {error}")
                
                # IMPROVED: More selective detection of errors that warrant wheelhouse clearing
                # Only clear wheelhouse if there's actual evidence of corrupted/incompatible wheels
                
                # Check if this is a WHEELHOUSE-SPECIFIC error (corrupted wheels, missing wheels)
                is_wheelhouse_error = any(phrase in error for phrase in [
                    "Could not find a version",
                    "No matching distribution found",
                    "Invalid wheel",
                    "corrupted",
                    "METADATA file",
                    "not a supported wheel"
                ])
                
                # Check if this is an import error (package installed but imports fail)
                # These should NOT trigger wheelhouse clearing - they're usually dependency issues
                is_import_error = any(phrase in error.lower() for phrase in [
                    "importerror",
                    "modulenotfounderror",
                    "cannot import name",
                    "no module named"
                ])
                
                # Check if this is a version conflict error (package installed but wrong version)
                # These should trigger repair, but preserve wheelhouse if possible
                is_version_conflict = any(phrase in error.lower() for phrase in [
                    "is required",
                    "but found"
                ]) and "version" in error.lower()
                
                has_wheelhouse = wheelhouse_path.exists() and len(list(wheelhouse_path.glob("*.whl"))) > 0
                
                # Only retry with wheelhouse operations if it's a wheelhouse error OR version conflict
                # Do NOT retry on simple import errors - those need dependency fixes, not re-downloads
                should_retry_with_wheelhouse = (is_wheelhouse_error or is_version_conflict) and has_wheelhouse and not is_import_error
                
                if should_retry_with_wheelhouse:
                    if is_version_conflict:
                        self.log("\n⚠ Detected version conflict - package installed but wrong version")
                        self.log("  Will try to repair without clearing wheelhouse first...")
                    elif is_wheelhouse_error:
                        self.log("\n⚠ Detected wheelhouse error - missing or corrupted wheel files")
                        self.log("  Will validate wheelhouse and re-download only if needed")
                    
                    # Check if venv exists - if so, try resume mode first WITHOUT clearing wheelhouse
                    venv_exists = venv_path.exists()
                    wheelhouse_valid = False
                    wheelhouse_needs_clearing = False
                    
                    if venv_exists:
                        # Check if wheelhouse validation passes (wheels satisfy current requirements)
                        self.log("\n🔄 Checking if wheelhouse can be used for resume...")
                        wheelhouse_mgr = WheelhouseManager(self.manifest_path, wheelhouse_path)
                        python_version = (sys.version_info.major, sys.version_info.minor)
                        
                        # Validate wheelhouse against current requirements
                        is_valid, error_msg = wheelhouse_mgr._validate_wheelhouse_requirements(package_versions)
                        wheelhouse_valid = is_valid
                        
                        if is_valid:
                            self.log("  ✓ Wheelhouse validation passed - wheels satisfy current requirements")
                            self.log("  ✓ Venv exists - will resume installation from where we left off")
                            self.log("  ✓ Keeping wheelhouse intact (no re-download needed)")
                            self.log("\n🔄 Retrying installation in resume mode...")
                            self.log("=" * 60)
                            
                            # Retry with resume mode (don't clear venv or wheelhouse)
                            python_exe = getattr(self, '_python_executable', None)
                            python_exe = Path(python_exe) if python_exe else None
                            installer = ImmutableInstaller(venv_path, wheelhouse_path, self.manifest_path, python_executable=python_exe)
                            success, error = installer.install(cuda_config, package_versions=package_versions, binary_packages=binary_packages if self.use_adaptive else None)
                            
                            if success:
                                self.log("\n✓ Installation succeeded after resume!")
                                return True
                            else:
                                self.log(f"\n⚠ Resume failed: {error}")
                                self.log("  Will now clear wheelhouse and re-download...")
                                wheelhouse_needs_clearing = True
                        else:
                            self.log(f"  ⚠ Wheelhouse validation failed: {error_msg}")
                            self.log("  Wheelhouse needs to be cleared and re-downloaded")
                            wheelhouse_needs_clearing = True
                    else:
                        # No venv exists - if wheelhouse error, we need to clear and re-download
                        if is_wheelhouse_error:
                            self.log("  ⚠ No venv exists and wheelhouse has errors")
                            wheelhouse_needs_clearing = True
                    
                    # Only clear wheelhouse if validation failed OR it's a wheelhouse error
                    if wheelhouse_needs_clearing or is_wheelhouse_error:
                        # Full retry: Clear wheelhouse and re-download
                        self.log("\n🔄 Clearing wheelhouse and re-downloading (wheelhouse validation failed or corrupted)...")
                        
                        # Clear wheelhouse only
                        import shutil
                        shutil.rmtree(wheelhouse_path, ignore_errors=True)
                        self.log("  ✓ Wheelhouse cleared")
                        
                        # Only clear venv if it doesn't exist OR wheelhouse validation failed
                        if not venv_exists or not wheelhouse_valid:
                            if venv_path.exists():
                                shutil.rmtree(venv_path, ignore_errors=True)
                                self.log("  ✓ Venv cleared")
                        
                        self.log("\n🔄 Retrying installation with fresh downloads for your GPU...")
                        self.log("=" * 60)
                        
                        # Retry: Prepare wheelhouse again
                        self.log("\nPHASE 1 (RETRY): Wheelhouse Preparation")
                        self.log("-" * 60)
                        
                        wheelhouse_mgr = WheelhouseManager(self.manifest_path, wheelhouse_path)
                        python_version = (sys.version_info.major, sys.version_info.minor)
                        success, error = wheelhouse_mgr.prepare_wheelhouse(
                            cuda_config, 
                            python_version,
                            package_versions,
                            binary_packages if self.use_adaptive else None,  # Pass binary packages if using profile
                            force_redownload=True  # Force fresh download
                        )
                        
                        if not success:
                            self.log(f"\n✗ Retry failed - wheelhouse preparation:")
                            self.log(f"  {error}")
                            return False
                        
                        self.log("\n✓ Wheelhouse ready (retry)")
                        
                        # Retry: Install again
                        self.log("\nPHASE 2-6 (RETRY): Environment Installation")
                        self.log("-" * 60)
                        
                        python_exe = getattr(self, '_python_executable', None)
                        python_exe = Path(python_exe) if python_exe else None
                        installer = ImmutableInstaller(venv_path, wheelhouse_path, self.manifest_path, python_executable=python_exe)
                        success, error = installer.install(cuda_config, package_versions=package_versions, binary_packages=binary_packages if self.use_adaptive else None)
                        
                        if not success:
                            self.log(f"\n✗ Installation still failed after retry:")
                            self.log(f"  {error}")
                            return False
                        
                        self.log("\n✓ Installation succeeded after retry!")
                    else:
                        # Wheelhouse is OK, just return error without clearing
                        self.log("  ℹ Wheelhouse is valid - keeping it intact")
                        self.log("  ℹ This error doesn't warrant clearing the wheelhouse")
                        return False
                else:
                    # Not a wheelhouse or version error - don't clear wheelhouse, just fail
                    if is_import_error:
                        self.log("\n⚠ This is an import error, not a wheelhouse problem")
                        self.log("  Wheelhouse will NOT be cleared - the issue is with dependencies or installation")
                    self.log("  ℹ Preserving wheelhouse - can retry with same downloads")
                    return False
            
            self.log("\n" + "=" * 60)
            self.log("✓ Installation complete!")
            self.log("=" * 60)
            self.log(f"\nVirtual environment: {venv_path}")
            self.log(f"Python executable: {venv_path / 'Scripts' / 'python.exe' if sys.platform == 'win32' else venv_path / 'bin' / 'python'}")
            self.log("\nYou can now launch the application.")
            
            # Save fallback state (in case ImmutableInstaller didn't save it)
            try:
                self._save_fallback_state(cuda_config, success=True, env_dir=venv_path.parent, venv_path=venv_path)
            except TypeError:
                # Backward compatibility if signature differs
                self._save_fallback_state(cuda_config, success=True)
            
            return True
            
        except KeyboardInterrupt:
            self.log("\n\nInstallation interrupted by user")
            # Save fallback state for interrupted install
            try:
                cuda_config = self._determine_cuda_config(detector.detect_all() if 'detector' in locals() else {})
                self._save_fallback_state(cuda_config, success=False)
            except:
                pass
            return False
        except Exception as e:
            self.log(f"\n✗ Installation failed with exception:")
            self.log(f"  {type(e).__name__}: {str(e)}")
            
            import traceback
            self.log("\nFull traceback:")
            self.log(traceback.format_exc())
            
            # Save fallback state for failed install
            try:
                cuda_config = self._determine_cuda_config(detector.detect_all() if 'detector' in locals() else {})
                self._save_fallback_state(cuda_config, success=False)
            except:
                pass
            
            return False
    
    def repair_model_environment(self, model_id: str = None, model_path: str = None) -> bool:
        """
        Repair a specific model's isolated environment.
        Creates the environment if it doesn't exist, then installs/repairs packages.
        
        Args:
            model_id: HuggingFace model ID
            model_path: Local model path
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.log("=" * 60)
            self.log(f"Repairing environment for model: {model_id or model_path}")
            self.log("=" * 60)
            
            # Get or create model environment
            env_path = self.env_manager.get_environment_path(model_id=model_id, model_path=model_path)
            venv_path = env_path / ".venv"
            
            if not venv_path.exists():
                self.log(f"\nCreating new environment for model at: {env_path}")
                # Get Python runtime
                python_runtime = self.python_runtime_manager.get_python_runtime("3.12")
                if not python_runtime:
                    self.log("\n✗ Failed to get Python runtime")
                    return False
                
                # Get hardware profile
                detector = SystemDetector()
                detector.detect_all()
                hw_profile = detector.get_hardware_profile()
                from core.profile_selector import ProfileSelector
                selector = ProfileSelector(self.compat_matrix_path)
                profile_name, _, _, _ = selector.select_profile(hw_profile)
                
                # Create environment
                success, error = self.env_manager.create_environment(
                    model_id=model_id,
                    model_path=model_path,
                    python_runtime=python_runtime,
                    profile_name=profile_name
                )
                if not success:
                    self.log(f"\n✗ Failed to create environment: {error}")
                    return False
                self.log("✓ Environment created")
            
            # Get venv Python
            if sys.platform == 'win32':
                target_python = venv_path / "Scripts" / "python.exe"
            else:
                target_python = venv_path / "bin" / "python"
            
            if not target_python.exists():
                self.log(f"\n✗ Python not found in environment: {target_python}")
                return False
            
            self.log(f"\nTarget environment: {env_path}")
            self.log(f"Target Python: {target_python}")
            
            # Continue with normal repair flow but targeting this environment
            # (rest of repair logic, but use venv_path instead of self.venv)
            # For now, delegate to the main repair but with custom venv path
            # We'll need to modify ImmutableInstaller to accept a custom venv path
            
            # Detection
            detector = SystemDetector()
            results = detector.detect_all()
            results['python'] = {
                'found': True,
                'version': f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                'executable': str(target_python),
                'path': str(target_python.parent),
                'pip_available': True
            }
            
            # Get profile
            if self.use_adaptive:
                from core.profile_selector import ProfileSelector
                hw_profile = detector.get_hardware_profile()
                selector = ProfileSelector(self.compat_matrix_path)
                profile_name, package_versions, warnings, binary_packages = selector.select_profile(hw_profile)
                cuda_config = self._extract_cuda_config(package_versions.get("torch", ""))
                env_key = self._derive_env_key(package_versions)
                _shared_venv_path, wheelhouse_path, _env_dir = self._get_env_paths(env_key)
                self.log(f"✓ Using wheelhouse cache for env_key: {env_key}")
                self.log(f"  Wheelhouse path: {wheelhouse_path}")
            else:
                cuda_config = self._determine_cuda_config(results)
                package_versions = None
                binary_packages = None
                wheelhouse_path = self.wheelhouse
            
            # Prepare wheelhouse
            wheelhouse_mgr = WheelhouseManager(self.manifest_path, wheelhouse_path)
            python_version = (sys.version_info.major, sys.version_info.minor)
            success, error = wheelhouse_mgr.prepare_wheelhouse(
                cuda_config, 
                python_version,
                package_versions,
                binary_packages if self.use_adaptive else None,
                force_redownload=False
            )
            
            if not success:
                self.log(f"\n✗ Wheelhouse preparation failed: {error}")
                return False
            
            # Install packages into this model's environment
            python_runtime = self.python_runtime_manager.get_python_runtime("3.12")
            installer = ImmutableInstaller(venv_path, wheelhouse_path, self.manifest_path, python_executable=python_runtime)
            # Route installer logs to GUI
            installer.log = self.log
            success, error = installer.install(
                cuda_config,
                package_versions=package_versions,
                binary_packages=binary_packages if self.use_adaptive else None
            )
            
            if not success:
                self.log(f"\n✗ Installation failed: {error}")
                return False
            
            self.log("\n" + "=" * 60)
            self.log("✓ Model environment repair complete!")
            self.log("=" * 60)
            return True
            
        except Exception as e:
            self.log(f"\n✗ Repair failed: {e}")
            import traceback
            self.log(traceback.format_exc())
            return False
    
    def repair(self) -> bool:
        """
        Repair mode: Only fix broken/missing packages without destroying venv.
        Reuses existing wheelhouse and preserves working packages.
        
        Returns:
            True if repair successful, False otherwise
        """
        try:
            self.log("=" * 60)
            self.log("LLM Fine-tuning Studio - Repair Mode")
            self.log("=" * 60)
            # PHASE 0: Detection
            self.log("\nPHASE 0: Hardware and Platform Detection")
            self.log("-" * 60)
            detector = SystemDetector()
            results = detector.detect_all()
            self._display_detection_results(results)

            # Select target profile (adaptive) to determine env_key and paths
            if self.use_adaptive:
                self.log("\n🎯 Using hardware-adaptive repair")
                from core.profile_selector import ProfileSelector
                from setup_state import SetupStateManager

                setup_state = SetupStateManager()
                selected_gpu_index = setup_state.get_selected_gpu_index()
                override_profile = setup_state.get_selected_profile()
                hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)

                selector = ProfileSelector(self.compat_matrix_path)
                profile_name, package_versions, warnings, binary_packages = selector.select_profile(
                    hw_profile, override_profile_id=override_profile
                )
                self.log(f"\n✓ Selected profile: {profile_name}")
                for warning in warnings:
                    self.log(f"  ⚠ {warning}")
                cuda_config = self._extract_cuda_config(package_versions.get("torch", ""))

                env_key = self._derive_env_key(package_versions)
                venv_path, wheelhouse_path, env_dir = self._get_env_paths(env_key)
                self.log(f"✓ Target env_key: {env_key}")
                self.log(f"  Venv path: {venv_path}")
                self.log(f"  Wheelhouse path: {wheelhouse_path}")
                self._maybe_migrate_legacy_layout(env_key, venv_path, wheelhouse_path)
            else:
                self.log("\n⚠ Using legacy fixed-version repair")
                cuda_config = self._determine_cuda_config(results)
                package_versions = None
                binary_packages = None
                env_key = None
                venv_path = self.venv
                wheelhouse_path = self.wheelhouse
                env_dir = self.root

            self.log(f"\n✓ Target configuration: {cuda_config}")

            # Determine Python runtime for venv creation if needed
            self.log("\nChecking for self-contained Python runtime...")
            python_runtime = self.python_runtime_manager.get_python_runtime("3.12")
            if python_runtime:
                self.log(f"✓ Using self-contained Python runtime: {python_runtime}")
                self._python_executable = python_runtime
            else:
                self.log("⚠ Self-contained Python runtime not available, using system Python")
                self._python_executable = sys.executable

            # PHASE 1: Prepare wheelhouse (ALWAYS - includes validation)
            self.log("\nPHASE 1: Wheelhouse Preparation & Validation")
            self.log("-" * 60)
            self.log(f"  Wheelhouse path: {wheelhouse_path}")

            wheelhouse_mgr = WheelhouseManager(self.manifest_path, wheelhouse_path)
            wheelhouse_mgr.log = self.log

            python_version = (sys.version_info.major, sys.version_info.minor)
            success, error = wheelhouse_mgr.prepare_wheelhouse(
                cuda_config,
                python_version,
                package_versions,
                binary_packages if self.use_adaptive else None,
                force_redownload=False,
            )
            if not success:
                self.log(f"\n✗ Wheelhouse preparation failed:")
                self.log(f"  {error}")
                try:
                    self._save_fallback_state(cuda_config, success=False, env_dir=env_dir, venv_path=venv_path)
                except Exception:
                    pass
                return False

            self.log("\n✓ Wheelhouse ready and validated")

            # PHASE 2-6: Repair (resume mode; ImmutableInstaller will skip correct packages)
            self.log("\nPHASE 2-6: Repair Installation (resume mode)")
            self.log("-" * 60)

            python_exe = getattr(self, '_python_executable', None)
            python_exe = Path(python_exe) if python_exe else None
            installer = ImmutableInstaller(venv_path, wheelhouse_path, self.manifest_path, python_executable=python_exe)
            installer.log = self.log

            success, error = installer.install(
                cuda_config,
                package_versions=package_versions,
                binary_packages=binary_packages if self.use_adaptive else None,
                allow_destroy=False,
            )
            if not success:
                self.log(f"\n✗ Repair failed:")
                self.log(f"  {error}")
                try:
                    self._save_fallback_state(cuda_config, success=False, env_dir=env_dir, venv_path=venv_path)
                except Exception:
                    pass
                return False

            self.log("\n" + "=" * 60)
            self.log("✓ Repair complete!")
            self.log("=" * 60)
            self.log(f"\nVirtual environment: {venv_path}")
            self.log(f"Python executable: {venv_path / 'Scripts' / 'python.exe' if sys.platform == 'win32' else venv_path / 'bin' / 'python'}")
            self.log("\nYou can now launch the application.")

            # Save fallback state for successful repair (per-env)
            try:
                self._save_fallback_state(cuda_config, success=True, env_dir=env_dir, venv_path=venv_path)
            except Exception:
                pass

            return True
            
        except KeyboardInterrupt:
            self.log("\n\nRepair interrupted by user")
            # Save fallback state for interrupted repair
            try:
                cuda_config = self._determine_cuda_config(detector.detect_all() if 'detector' in locals() else {})
                self._save_fallback_state(cuda_config, success=False)
            except:
                pass
            return False
        except Exception as e:
            self.log(f"\n✗ Repair failed with exception:")
            self.log(f"  {type(e).__name__}: {str(e)}")
            
            import traceback
            self.log("\nFull traceback:")
            self.log(traceback.format_exc())
            
            # Save fallback state for exception during repair
            try:
                cuda_config = self._determine_cuda_config(detector.detect_all() if 'detector' in locals() else {})
                self._save_fallback_state(cuda_config, success=False)
            except:
                pass
            
            return False
    
    def rebuild(self) -> bool:
        """
        Rebuild mode: Delete .venv and wheelhouse, then perform fresh installation.
        This is a destructive operation that wipes everything and starts from scratch.
        
        Returns:
            True if rebuild successful, False otherwise
        """
        try:
            self.log("=" * 60)
            self.log("LLM Fine-tuning Studio - Rebuild Mode")
            self.log("=" * 60)
            self.log("WARNING: This will delete the ACTIVE environment and its wheelhouse cache.")
            self.log("Other environments (for other GPUs/profiles) will be kept.")
            self.log("=" * 60)

            # Determine active env_key (adaptive) so we only wipe the active env
            venv_path = self.venv
            wheelhouse_path = self.wheelhouse
            env_dir = self.root

            if self.use_adaptive:
                try:
                    detector = SystemDetector()
                    detector.detect_all()
                    from core.profile_selector import ProfileSelector
                    from setup_state import SetupStateManager
                    setup_state = SetupStateManager()
                    selected_gpu_index = setup_state.get_selected_gpu_index()
                    override_profile = setup_state.get_selected_profile()
                    hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)
                    selector = ProfileSelector(self.compat_matrix_path)
                    _profile_name, package_versions, _warnings, _binary_packages = selector.select_profile(
                        hw_profile, override_profile_id=override_profile
                    )
                    env_key = self._derive_env_key(package_versions)
                    venv_path, wheelhouse_path, env_dir = self._get_env_paths(env_key)
                    self.log(f"Active env_key: {env_key}")
                except Exception as e:
                    self.log(f"⚠ Could not resolve active env_key; falling back to legacy rebuild: {e}")

            # Delete active venv if it exists
            if venv_path.exists():
                self.log(f"\nDeleting virtual environment: {venv_path}")
                try:
                    if sys.platform == 'win32':
                        result = subprocess.run(
                            ['cmd', '/c', 'rmdir', '/S', '/Q', str(venv_path)],
                            capture_output=True,
                            text=True,
                            timeout=60
                        )
                        if result.returncode != 0 and venv_path.exists():
                            raise RuntimeError(f"Failed to delete venv: {result.stderr}")
                    else:
                        shutil.rmtree(venv_path, ignore_errors=False)
                    self.log("  ✓ Virtual environment deleted")
                except Exception as e:
                    self.log(f"  ✗ Failed to delete venv: {e}")
                    return False
            else:
                self.log("\nNo existing virtual environment to delete")

            # Delete active wheelhouse cache if it exists
            if wheelhouse_path.exists():
                self.log(f"\nDeleting wheelhouse cache: {wheelhouse_path}")
                try:
                    shutil.rmtree(wheelhouse_path, ignore_errors=False)
                    self.log("  ✓ Wheelhouse cache deleted")
                except Exception as e:
                    self.log(f"  ✗ Failed to delete wheelhouse: {e}")
                    return False
            else:
                self.log("\nNo existing wheelhouse cache to delete")
            
            # Now run fresh installation with allow_destroy=True
            self.log("\n" + "=" * 60)
            self.log("Starting fresh installation...")
            self.log("=" * 60)
            
            return self.install(skip_wheelhouse=False, allow_destroy=True)
            
        except KeyboardInterrupt:
            self.log("\n\nRebuild interrupted by user")
            return False
        except Exception as e:
            self.log(f"\n✗ Rebuild failed with exception:")
            self.log(f"  {type(e).__name__}: {str(e)}")
            
            import traceback
            self.log("\nFull traceback:")
            self.log(traceback.format_exc())
            
            return False
    
    def _display_detection_results(self, results: dict):
        """Display hardware detection results"""
        # Python
        python_info = results.get("python", {})
        if python_info.get("found"):
            self.log(f"  Python: {python_info.get('version')} at {python_info.get('executable')}")
        
        # CUDA
        cuda_info = results.get("cuda", {})
        if cuda_info.get("found"):
            gpus = cuda_info.get("gpus", [])
            cuda_ver = cuda_info.get("version")
            driver_ver = cuda_info.get("driver_version")
            cuda_label = cuda_ver if (cuda_ver and str(cuda_ver) != "None") else "Unknown"
            if driver_ver:
                cuda_label = f"{cuda_label} (driver {driver_ver})"
            self.log(f"  CUDA: {cuda_label} with {len(gpus)} GPU(s)")
            for i, gpu in enumerate(gpus):
                # system_detector.py stores GPU memory under "memory" (often like "4096 MiB").
                # Older logs used "memory_mb" which may be absent; fall back to parsing "memory".
                mem_mb = gpu.get("memory_mb", 0)
                if not mem_mb:
                    mem_str = gpu.get("memory")
                    try:
                        import re
                        m = re.search(r"(\d+)", str(mem_str))
                        if m:
                            mem_mb = int(m.group(1))
                    except Exception:
                        mem_mb = 0
                cc = gpu.get("compute_capability")
                cc_str = f", CC {cc}" if cc else ""
                self.log(f"    GPU {i}: {gpu.get('name')} ({mem_mb} MB{cc_str})")
        else:
            self.log("  CUDA: Not detected")
        
        # Hardware
        hw_info = results.get("hardware", {})
        cpu_name = hw_info.get("cpu_name") or "Unknown CPU"
        cpu_dict = hw_info.get("cpu", {}) or {}
        cpu_cores = cpu_dict.get("cores")
        cpu_arch = cpu_dict.get("architecture")
        cpu_extra = []
        if cpu_cores:
            cpu_extra.append(f"{cpu_cores} cores")
        if cpu_arch:
            cpu_extra.append(str(cpu_arch))
        cpu_suffix = f" ({', '.join(cpu_extra)})" if cpu_extra else ""
        ram_gb = hw_info.get("ram_gb", 0) or 0
        self.log(f"  CPU: {cpu_name}{cpu_suffix}")
        self.log(f"  RAM: {ram_gb:.1f} GB")
    
    def _save_fallback_state(
        self,
        cuda_config: str = None,
        success: bool = False,
        env_dir: Path = None,
        venv_path: Path = None,
    ):
        """
        Save installation state at InstallerV2 level as fallback.
        This ensures state is saved even if ImmutableInstaller fails.
        
        Args:
            cuda_config: CUDA configuration used (if known)
            success: Whether installation succeeded
            env_dir: Optional environment directory to write state into (defaults to LLM root)
            venv_path: Optional venv path for this environment (defaults to self.venv)
        """
        try:
            from datetime import datetime
            
            if venv_path is None:
                venv_path = self.venv
            if env_dir is None:
                # Default to venv's parent if it exists, otherwise root.
                env_dir = venv_path.parent if isinstance(venv_path, Path) else self.root

            state = {
                "install_complete": success,
                "install_timestamp": datetime.now().isoformat(),
                "cuda_config": cuda_config or "unknown",
                "verification_passed": success,  # Assume verification passed if install succeeded
                "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "installer_level": "InstallerV2",  # Mark this as fallback state
                "venv_path": str(venv_path)
            }
            
            # Save to .install_state.json in the env directory (per-env state)
            state_file = Path(env_dir) / ".install_state.json"
            with open(state_file, 'w', encoding='utf-8') as f:
                json.dump(state, f, indent=2)
            
            self.log(f"  ✓ Fallback state saved to {state_file.name}")
            
            # Also create marker file for backwards compatibility
            if success:
                marker = Path(env_dir) / ".setup_complete"
                marker.touch()
                self.log(f"  ✓ Setup complete marker created")
            
        except Exception as e:
            self.log(f"  ⚠ Warning: Could not save fallback state: {e}")
    
    def _determine_cuda_config(self, detection_results: dict) -> str:
        """
        Determine which CUDA config to use based on detection.
        
        Args:
            detection_results: Results from SystemDetector
        
        Returns:
            CUDA config key (e.g., "cu124")
        
        Raises:
            ValueError: If no suitable CUDA configuration found
        """
        cuda_info = detection_results.get("cuda", {})
        
        if not cuda_info.get("found"):
            raise ValueError(
                "No CUDA GPU detected. This application requires CUDA.\n"
                "Please ensure:\n"
                "  1. NVIDIA GPU is installed\n"
                "  2. NVIDIA drivers are up to date\n"
                "  3. CUDA toolkit is installed"
            )
        
        cuda_version = cuda_info.get("version", "")
        driver_version = cuda_info.get("driver_version", "")
        
        # Handle missing CUDA version - try to infer from driver
        if not cuda_version or cuda_version == "None":
            if driver_version:
                try:
                    driver_major = int(driver_version.split('.')[0])
                    # Map driver version to CUDA version
                    # Driver 560+ supports CUDA 12.6+
                    # Driver 550+ supports CUDA 12.4+
                    # Driver 520+ supports CUDA 12.1+
                    if driver_major >= 550:
                        cuda_version = "12.4"
                        self.log(f"  Inferred CUDA 12.4+ from driver {driver_version}")
                    elif driver_major >= 520:
                        cuda_version = "12.1"
                        self.log(f"  Inferred CUDA 12.1+ from driver {driver_version}")
                    elif driver_major >= 470:
                        cuda_version = "11.8"
                        self.log(f"  Inferred CUDA 11.8+ from driver {driver_version}")
                    else:
                        raise ValueError(
                            f"Driver version {driver_version} is too old.\n"
                            f"Please update NVIDIA drivers to version 520+ for CUDA 12 support."
                        )
                except ValueError as e:
                    raise e
                except Exception:
                    pass
            
            if not cuda_version or cuda_version == "None":
                raise ValueError(
                    "Could not detect CUDA version. This application requires CUDA.\n"
                    "Please ensure:\n"
                    "  1. NVIDIA GPU is installed\n"
                    "  2. NVIDIA drivers are up to date (version 520+ recommended)\n"
                    "  3. Run 'nvidia-smi' in terminal to verify driver installation"
                )
        
        # Map CUDA version to config
        if cuda_version.startswith("12.6") or cuda_version.startswith("12.5") or cuda_version.startswith("12.4"):
            return "cu124"
        elif cuda_version.startswith("12.3") or cuda_version.startswith("12.2") or cuda_version.startswith("12.1"):
            return "cu121"
        elif cuda_version.startswith("11.8"):
            return "cu118"
        else:
            # Try to find closest match
            try:
                major, minor = map(int, cuda_version.split(".")[:2])
                if major == 12:
                    # For CUDA 12.x, use cu124 as default
                    self.log(f"  WARNING: CUDA {cuda_version} not explicitly supported, using cu124")
                    return "cu124"
                elif major == 11 and minor >= 8:
                    self.log(f"  WARNING: CUDA {cuda_version} not explicitly supported, using cu118")
                    return "cu118"
            except:
                pass
            
            raise ValueError(
                f"Unsupported CUDA version: {cuda_version}\n"
                f"Supported versions: 11.8, 12.1-12.3, 12.4-12.6\n"
                f"Please update your NVIDIA drivers"
            )
    
    def _extract_cuda_config(self, torch_version: str) -> str:
        """Extract CUDA config from torch version string like '2.5.1+cu124' → 'cu124'"""
        if "+cu" in torch_version:
            parts = torch_version.split("+cu")
            if len(parts) > 1:
                return "cu" + parts[1][:3]  # Extract '124' from 'cu124' or just 'cu124'
        # Default fallback based on most common
        return "cu121"
    
    def verify_installation(self) -> bool:
        """
        Verify an existing installation.
        
        Returns:
            True if installation is valid, False otherwise
        """
        try:
            self.log("Verifying installation...")

            # Resolve active env (adaptive) so verify checks the correct env for this GPU
            venv_path = self.venv
            if self.use_adaptive:
                try:
                    detector = SystemDetector()
                    detector.detect_all()
                    from core.profile_selector import ProfileSelector
                    from setup_state import SetupStateManager
                    setup_state = SetupStateManager()
                    selected_gpu_index = setup_state.get_selected_gpu_index()
                    override_profile = setup_state.get_selected_profile()
                    hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)
                    selector = ProfileSelector(self.compat_matrix_path)
                    _profile_name, package_versions, _warnings, _binary_packages = selector.select_profile(
                        hw_profile, override_profile_id=override_profile
                    )
                    env_key = self._derive_env_key(package_versions)
                    venv_path, _wheelhouse_path, _env_dir = self._get_env_paths(env_key)
                    self.log(f"✓ Verifying active env_key: {env_key}")
                except Exception as e:
                    self.log(f"⚠ Could not resolve env_key for verification, using legacy .venv: {e}")
                    venv_path = self.venv

            # Check venv exists
            if not venv_path.exists():
                self.log(f"✗ Virtual environment not found: {venv_path}")
                return False

            # Get venv Python
            if sys.platform == 'win32':
                venv_python = venv_path / "Scripts" / "python.exe"
            else:
                venv_python = venv_path / "bin" / "python"
            
            if not venv_python.exists():
                self.log("✗ Python executable not found in venv")
                return False
            
            # Run verification
            from core.verification import VerificationSystem
            
            verifier = VerificationSystem(self.manifest_path, venv_python)
            success, error = verifier.run_quick_verify()
            
            if success:
                self.log("✓ Installation verified")
                return True
            else:
                self.log(f"✗ Verification failed: {error}")
                return False
                
        except Exception as e:
            self.log(f"✗ Verification error: {str(e)}")
            return False


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="LLM Fine-tuning Studio - Immutable Installer v2.0",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python installer_v2.py                    # Full installation
  python installer_v2.py --skip-wheelhouse  # Skip download, use existing wheels
  python installer_v2.py --verify           # Verify existing installation
"""
    )
    
    parser.add_argument(
        "--skip-wheelhouse",
        action="store_true",
        help="Skip wheelhouse preparation (use existing wheels)"
    )
    
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify existing installation instead of installing"
    )
    
    args = parser.parse_args()
    
    try:
        installer = InstallerV2()
        
        if args.verify:
            # Verification mode
            success = installer.verify_installation()
        else:
            # Installation mode
            success = installer.install(skip_wheelhouse=args.skip_wheelhouse)
        
        sys.exit(0 if success else 1)
        
    except Exception as e:
        try:
            print(f"\nFATAL ERROR: {str(e)}")
        except Exception:
            pass
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

