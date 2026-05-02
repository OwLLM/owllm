#!/usr/bin/env python3
"""
Immutable Installer - Atomic installation system
Part of the Immutable Installer system
"""

import sys
import os
import shutil
import subprocess
import json
import time
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from datetime import datetime

# Try to import packaging for version validation
try:
    from packaging.specifiers import SpecifierSet
    from packaging import version as pkg_version
    PACKAGING_AVAILABLE = True
except ImportError:
    PACKAGING_AVAILABLE = False
    SpecifierSet = None
    pkg_version = None

# Try to import importlib.metadata for package checking
try:
    from importlib.metadata import version as get_package_version, PackageNotFoundError
    METADATA_AVAILABLE = True
except ImportError:
    # Fallback for Python < 3.8
    try:
        from importlib_metadata import version as get_package_version, PackageNotFoundError
        METADATA_AVAILABLE = True
    except ImportError:
        METADATA_AVAILABLE = False
        get_package_version = None
        PackageNotFoundError = Exception


class InstallationFailed(Exception):
    """Raised when installation fails"""
    pass


class ImmutableInstaller:
    """
    Immutable installer - always starts fresh, never repairs in place.
    Creates new venv, installs from wheelhouse offline, verifies integrity.
    """
    
    def __init__(self, venv_path: Path, wheelhouse_path: Path, manifest_path: Path, python_executable: Path = None):
        """
        Initialize immutable installer.
        
        Args:
            venv_path: Path where venv should be created
            wheelhouse_path: Path to wheelhouse with downloaded wheels
            manifest_path: Path to dependencies.json manifest
            python_executable: Optional Python executable to use for creating venv (defaults to sys.executable)
        """
        self.venv_path = venv_path
        self.wheelhouse = wheelhouse_path
        self.manifest_path = manifest_path  # Store for use in fallback downloads
        self.python_executable = Path(python_executable) if python_executable else Path(sys.executable)
        
        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = json.load(f)
        
        self.torch_lock = venv_path / ".torch_lock"
        
        # Do not hide child console windows.
        self.subprocess_flags = {}

        # Track auto-heal attempts per missing requirement to avoid infinite loops.
        # Key: normalized requirement string (lowercase, hyphenated).
        self._autoheal_attempts: Dict[str, int] = {}
    
    def log(self, message: str):
        """Log message to console with encoding safety"""
        try:
            print(f"[INSTALL] {message}")
        except UnicodeEncodeError:
            # Fallback for Windows consoles that don't support UTF-8 characters
            safe_message = message.replace('✓', '[OK]').replace('✗', '[FAIL]').replace('⚠', '[WARN]')
            try:
                print(f"[INSTALL] {safe_message}")
            except Exception:
                pass
    
    def install(self, cuda_config: str, package_versions: dict = None, binary_packages: dict = None, allow_destroy: bool = False) -> Tuple[bool, str]:
        """
        Perform immutable installation.
        
        Args:
            cuda_config: CUDA configuration key (e.g., "cu124")
            package_versions: Optional dict of {package_name: exact_version} from profile.
                            If provided, uses these for version checking instead of manifest.
            binary_packages: Optional dict of binary packages to install from wheels.
            allow_destroy: If True, allows deletion of existing .venv. If False (default),
                          will fail with error if venv appears corrupted instead of deleting it.
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        try:
            self.log("=" * 60)
            self.log("Immutable Installation Engine Started")
            self.log(f"  Configuration: {cuda_config}")
            if package_versions:
                self.log(f"  Using profile versions: {len(package_versions)} packages")
            if binary_packages:
                self.log(f"  Binary packages: {len(binary_packages)} packages")
                for pkg_name in binary_packages.keys():
                    self.log(f"    - {pkg_name}")
            else:
                self.log(f"  Binary packages: None (not provided)")
            self.log("=" * 60)
            
            # Store profile versions and binary packages for installation
            # Normalize package names in profile_versions to ensure consistent lookup
            self.profile_versions = {}
            if package_versions:
                for pkg_name, pkg_ver in package_versions.items():
                    # Normalize to lowercase with hyphens for consistent lookup
                    normalized = pkg_name.lower().replace("_", "-")
                    self.profile_versions[normalized] = pkg_ver
                    # Also store original name for backward compatibility
                    self.profile_versions[pkg_name] = pkg_ver
            self.binary_packages = binary_packages or {}
            
            # DEBUG: Log what we stored
            if self.profile_versions:
                self.log(f"[DEBUG] Stored {len(self.profile_versions)} profile versions: {list(self.profile_versions.keys())[:10]}...")
            if self.binary_packages:
                self.log(f"[DEBUG] Stored {len(self.binary_packages)} binary packages: {list(self.binary_packages.keys())}")
            else:
                self.log(f"[DEBUG] No binary packages stored")
            
            # PHASE 0: Validation
            self.log("[STEP] PHASE 0: Validating environment...")
            self._validate_environment()
            self.log("  ✓ Environment valid")
            
            # PHASE 1: Wheelhouse already prepared by WheelhouseManager
            self.log("[STEP] PHASE 1: Verifying wheelhouse...")
            if not self.wheelhouse.exists():
                raise InstallationFailed(f"Wheelhouse not found at {self.wheelhouse}")
            
            wheel_count = len(list(self.wheelhouse.glob("*.whl")))
            if wheel_count == 0:
                raise InstallationFailed("Wheelhouse is empty - no wheels found")
            self.log(f"  ✓ Wheelhouse contains {wheel_count} wheels")
            
            # PHASE 2: Resume detection - check if venv exists and is valid
            self.log("[STEP] PHASE 2: Checking existing venv for repair...")
            venv_python = None
            should_resume = False
            packages_to_install = []
            
            if self.venv_path.exists():
                self.log("  Found existing .venv directory")
                # Check if venv Python exists
                if sys.platform == 'win32':
                    venv_python_path = self.venv_path / "Scripts" / "python.exe"
                else:
                    venv_python_path = self.venv_path / "bin" / "python"
                
                if venv_python_path.exists():
                    venv_python = venv_python_path
                    self.log("PHASE 2: Checking existing venv for resume capability")
                    self.log("  Starting package verification checks...")
                        
                    # Verify Python version matches
                    try:
                        result = subprocess.run(
                            [str(venv_python), "--version"],
                            capture_output=True,
                            text=True,
                            timeout=30,  # Increased from 10s to 30s to handle slow systems
                            **self.subprocess_flags
                        )
                        if result.returncode == 0:
                            self.log(f"  ✓ Venv Python found: {result.stdout.strip()}")
                            # Critical: remove known-bad packages (e.g. torchao) before any import checks.
                            self._uninstall_blacklisted_packages(venv_python)
                            
                            # Check which packages need installation
                            deps = sorted(self.manifest["core_dependencies"], key=lambda x: x["order"])
                            cuda_packages = self.manifest["cuda_configs"][cuda_config]["packages"]
                            
                            # Use profile versions if available, otherwise fall back to manifest
                            if self.profile_versions:
                                # Profile mode: use exact versions from profile
                                cuda_packages_to_check = {k: self.profile_versions.get(k, v) for k, v in cuda_packages.items()}
                                self.log(f"  Using profile versions for CUDA packages: {list(cuda_packages_to_check.keys())}")
                            else:
                                cuda_packages_to_check = cuda_packages
                            
                            missing_packages = []
                            wrong_version_packages = []
                            
                            self.log(f"  Checking {len(cuda_packages_to_check)} CUDA package(s)...")
                            # Check CUDA packages (with functionality check for broken packages)
                            for pkg_name, pkg_version in cuda_packages_to_check.items():
                                version_spec = f"=={pkg_version}" if not pkg_version.startswith(("==", ">=", "<")) else pkg_version
                                self.log(f"  Checking {pkg_name} (required: {version_spec})...")
                                is_installed, version_matches, is_broken = self._check_package_installed(
                                    venv_python, pkg_name, version_spec, check_functionality=True
                                )
                                if not is_installed:
                                    self.log(f"    ⚠ {pkg_name} is MISSING")
                                    missing_packages.append((pkg_name, version_spec))
                                elif is_broken:
                                    # Only add if actually broken (DLL corruption, missing attributes, etc.)
                                    self.log(f"    ⚠ {pkg_name} is BROKEN (will reinstall)")
                                    wrong_version_packages.append((pkg_name, version_spec))
                                elif not version_matches:
                                    # Only add if version is wrong
                                    self.log(f"    ⚠ {pkg_name} version mismatch (will update)")
                                    wrong_version_packages.append((pkg_name, version_spec))
                                else:
                                    self.log(f"    ✓ {pkg_name} is OK")
                                # Otherwise: installed, correct version, not broken -> skip (don't add to any list)
                            
                            # Check core dependencies (with functionality check for broken packages)
                            for dep in deps:
                                pkg_name = dep["name"]
                                
                                # Skip platform-specific packages
                                if "platform" in dep and dep["platform"] != sys.platform:
                                    continue
                                
                                # Skip CUDA packages (already checked)
                                if dep["version"] == "FROM_CUDA_CONFIG":
                                    continue
                                
                                # Use profile version if available, otherwise use manifest version
                                # Profile versions may be ranges (e.g., ">=0.13.0,<0.16.0") or exact (e.g., "0.14.0")
                                # Normalize package name for lookup
                                pkg_normalized_check = pkg_name.lower().replace("_", "-")
                                profile_ver_check = None
                                if self.profile_versions:
                                    if pkg_normalized_check in self.profile_versions:
                                        profile_ver_check = self.profile_versions[pkg_normalized_check]
                                    elif pkg_name in self.profile_versions:
                                        profile_ver_check = self.profile_versions[pkg_name]
                                    elif pkg_name.replace("-", "_") in self.profile_versions:
                                        profile_ver_check = self.profile_versions[pkg_name.replace("-", "_")]
                                
                                if profile_ver_check:
                                    # Check if it's already a range or exact version
                                    if any(op in profile_ver_check for op in [">=", "<=", ">", "<", "!=", ","]):
                                        version_spec = profile_ver_check  # Use range as-is
                                    else:
                                        version_spec = f"=={profile_ver_check}"  # Exact version
                                else:
                                    version_spec = dep["version"]
                                
                                is_installed, version_matches, is_broken = self._check_package_installed(
                                    venv_python, pkg_name, version_spec, check_functionality=True
                                )
                                
                                if not is_installed:
                                    missing_packages.append((pkg_name, version_spec))
                                elif is_broken:
                                    # Only add if actually broken (import fails, missing attributes, etc.)
                                    wrong_version_packages.append((pkg_name, version_spec))
                                elif not version_matches:
                                    # Only add if version is wrong
                                    wrong_version_packages.append((pkg_name, version_spec))
                                # Otherwise: installed, correct version, not broken -> skip (don't add to any list)
                            
                            packages_to_install = missing_packages + wrong_version_packages
                            
                            if packages_to_install:
                                broken_packages = []
                                # Check which packages are broken (not just wrong version)
                                for pkg_name, version_spec in packages_to_install:
                                    is_installed, _, is_broken = self._check_package_installed(
                                        venv_python, pkg_name, version_spec, check_functionality=True
                                    )
                                    if is_broken:
                                        broken_packages.append(pkg_name)
                                
                                if broken_packages:
                                    self.log(f"  ⚠ Found {len(broken_packages)} broken packages: {', '.join(broken_packages)}")
                                
                                self.log(f"  ⚠ Found {len(packages_to_install)} packages that need installation:")
                                for pkg_name, version_spec in packages_to_install[:5]:  # Show first 5
                                    status = " (broken)" if pkg_name in broken_packages else ""
                                    self.log(f"    - {pkg_name}{version_spec}{status}")
                                if len(packages_to_install) > 5:
                                    self.log(f"    ... and {len(packages_to_install) - 5} more")
                                
                                # Check if critical packages are missing or wrong
                                critical_pkg_names = {dep["name"] for dep in deps if dep.get("critical", False)}
                                critical_pkg_names.update(cuda_packages.keys())  # CUDA packages are always critical
                                critical_missing = any(
                                    pkg_name in critical_pkg_names for pkg_name, _ in packages_to_install
                                )
                                
                                if critical_missing:
                                    self.log("  ⚠ Critical packages need installation - will resume from where we left off")
                                    should_resume = True
                                else:
                                    self.log("  ✓ Only non-critical packages need installation - will resume")
                                    should_resume = True
                            else:
                                self.log("  ✓ All regular packages already installed correctly")
                                # Still need to check binary packages
                                should_resume = True
                        else:
                            self.log(f"  ⚠ Python version check failed: {result.stderr or result.stdout}")
                            should_resume = False
                    
                    except Exception as e:
                        import traceback
                        self.log(f"  ⚠ Could not verify venv: {e}")
                        self.log(f"  Full error: {traceback.format_exc()}")
                        self.log("  Venv check failed; will create/rebuild as needed")
                        should_resume = False
                        venv_python = None
                else:
                    # Venv folder exists but its Python executable is missing -> cannot repair without rebuild.
                    self.log("PHASE 2: Existing venv is missing its Python executable")
                    self.log(f"  Expected: {venv_python_path}")
                    should_resume = False
            
            if not should_resume:
                # PHASE 2: Handle missing/corrupted venv
                #
                # Non-destructive rule:
                # - If the venv does NOT exist, we can safely create it (this is not "destroying").
                # - If the venv exists but is corrupted/incompatible, we only destroy it when
                #   allow_destroy=True (explicit Rebuild).
                if not self.venv_path.exists():
                    self.log("PHASE 2: No existing venv found - creating fresh venv")
                    self.log("PHASE 3: Creating fresh venv")
                    venv_python = self._create_venv()
                elif allow_destroy:
                    # Explicit rebuild requested - destroy and recreate
                    self.log("PHASE 2: Destroying existing venv (rebuild mode)")
                    self._destroy_venv()
                    
                    # PHASE 3: Create fresh venv
                    self.log("PHASE 3: Creating fresh venv")
                    venv_python = self._create_venv()
                else:
                    # Repair mode - do not destroy, fail with clear message
                    self.log("PHASE 2: Environment appears corrupted or incompatible")
                    self.log("  Environment cannot be safely repaired without destroying it.")
                    self.log("  Use 'Rebuild Environment' to recreate from scratch.")
                    return False, (
                        "Environment appears corrupted. Cannot resume installation.\n"
                        "Use 'Rebuild Environment' to delete and recreate the environment."
                    )
            else:
                if packages_to_install:
                    self.log("PHASE 2: Resuming installation (venv already exists)")
                    self.log(f"  Will install {len(packages_to_install)} missing/outdated packages")
                else:
                    self.log("PHASE 2: All packages already installed correctly")
                    self.log("  No installation needed - skipping to verification")

                # Python-tag compatibility self-heal.
                # Symptom: pip install <pkg>==<x>+cuYYY fails with "No
                # matching distribution found" even though the wheel is
                # right there in the wheelhouse — because the wheel's
                # cpXY tag doesn't match the venv's Python version. The
                # validation pass earlier doesn't catch this (it reads
                # metadata, not platform tags) so we check here on
                # resume.
                #
                # We CANNOT fix this by rebuilding the venv from inside
                # the running OWLLM app — Windows holds the venv's
                # python.exe and .pyd files locked because the app is
                # literally running from them, so any destroy step
                # leaves stragglers and breaks venv creation.
                #
                # The right move: leave the venv alone and re-download
                # the wheelhouse for the venv's Python tag. PHASE 4
                # then finds wheels that pip will accept, and we never
                # touched the live interpreter.
                tag_ok, venv_tag, required_tag = self._check_python_tag_compat(venv_python)
                if not tag_ok and required_tag and venv_tag:
                    self.log(
                        f"  ⚠ Python-tag mismatch: venv is {venv_tag}, wheelhouse "
                        f"contains {required_tag} wheels. Re-downloading the "
                        f"wheelhouse for {venv_tag} (the venv stays put)."
                    )
                    if not self._redownload_wheelhouse_for_tag(cuda_config, venv_tag):
                        return False, (
                            f"Could not refresh wheelhouse for Python {venv_tag}. "
                            f"Open a terminal (with OWLLM closed) and re-run the "
                            f"OWLLM installer to rebuild the wheelhouse from "
                            f"scratch, then reopen OWLLM."
                        )
                    self.log(f"  ✓ Wheelhouse refreshed for {venv_tag}")
                # End python-tag self-heal — same skip_installed semantics
                # as before (we did NOT touch the venv).
                skip_installed_arg = should_resume
            
            # PHASE 4: Atomic installation
            # ALWAYS run installation phase to check and install binary packages if needed
            # This ensures binary packages are installed automatically even when regular packages are OK
            self.log("[STEP] PHASE 4: Installing packages atomically")
            # If we just rebuilt the venv to fix a python-tag mismatch,
            # `skip_installed_arg` was set to False above. In every other
            # branch fall back to should_resume. Same for the packages
            # list — after a rebuild, install everything from scratch.
            effective_skip = locals().get("skip_installed_arg", should_resume)
            packages_to_install_param = packages_to_install if (should_resume and effective_skip) else None
            self.log(f"  should_resume={should_resume}, skip_installed={effective_skip}, packages_to_install count={len(packages_to_install_param) if packages_to_install_param else 0}")
            self.log(f"  binary_packages count={len(self.binary_packages) if self.binary_packages else 0}")

            # Always run _install_packages - it will handle both regular and binary packages
            self._install_packages(cuda_config, venv_python, skip_installed=effective_skip, packages_to_install=packages_to_install_param, binary_packages=self.binary_packages)
            
            # PHASE 4.5: Patch triton windows_utils.py (Windows only)
            if sys.platform == 'win32':
                self.log("[STEP] PHASE 4.5: Patching Triton for Windows CUDA detection")
                self._patch_triton_windows_utils(venv_python)
                self.log("[STEP] PHASE 4.6: Bootstrapping Triton Windows toolchain (libcuda/libpython)")
                self._bootstrap_triton_windows_toolchain(venv_python)
            
            # PHASE 5: Clear Python cache
            self.log("[STEP] PHASE 5: Clearing Python bytecode cache")
            self._clear_pycache()
            
            # PHASE 5.5: Save preliminary installation state
            # This ensures state file exists even if verification fails
            self.log("[STEP] PHASE 5.5: Saving preliminary installation state")
            self._save_install_state(cuda_config, verification_passed=False)
            self.log("  ✓ Preliminary state saved (verification pending)")
            
            # PHASE 6: Verification (two-phase: always run at end, not per-package)
            self.log("[STEP] PHASE 6: Verifying installation")
            # Always run verification - it will report which tests failed if any
            # This ensures we catch issues even after partial installs
            verification_passed = True
            try:
                self._verify_installation(venv_python)
            except InstallationFailed as e:
                verification_passed = False
                if should_resume and packages_to_install:
                    # In repair mode, log the failure but don't fail the entire operation
                    # User can run repair again or use Rebuild if needed
                    self.log(f"  ⚠ Verification found issues: {e}")
                    self.log("  Some packages may need additional repair. Run repair again or use Rebuild for a clean install.")
                else:
                    # In full install mode, verification failure is critical
                    raise
            
            # PHASE 7: Save installation state
            self.log("[STEP] PHASE 7: Updating installation state with verification result")
            self._save_install_state(cuda_config, verification_passed)
            if verification_passed:
                self.log("  ✓ Installation state updated - verification PASSED")
            else:
                self.log("  ✓ Installation state updated - verification FAILED (but packages installed)")
            
            self.log("=" * 60)
            self.log("✓ Installation complete")
            self.log("=" * 60)
            return True, ""
            
        except Exception as e:
            error_msg = str(e)
            self.log(f"✗ Installation failed: {error_msg}")
            
            # Check if this is a version conflict that might be fixable
            is_version_conflict = self._is_version_conflict_error(error_msg)
            
            if is_version_conflict:
                self.log("\n⚠ Detected version conflict error")
                self.log("  Attempting to fix by reinstalling problematic packages...")
                
                # Get venv Python if it exists
                if self.venv_path.exists():
                    if sys.platform == 'win32':
                        venv_python = self.venv_path / "Scripts" / "python.exe"
                    else:
                        venv_python = self.venv_path / "bin" / "python"
                    
                    if venv_python.exists():
                        # Try to fix version conflicts
                        fix_success = self._fix_version_conflicts(venv_python, error_msg)
                        
                        if fix_success:
                            self.log("\n🔄 Retrying installation from where we left off...")
                            # Retry installation in resume mode
                            try:
                                self._install_packages(
                                    cuda_config,
                                    venv_python,
                                    skip_installed=True,
                                    packages_to_install=None  # Install all missing/wrong packages
                                )
                                
                                # Clear cache and verify
                                self._clear_pycache()
                                verification_passed = True
                                try:
                                    self._verify_installation(venv_python)
                                except InstallationFailed:
                                    verification_passed = False
                                
                                # Save state after retry success
                                self._save_install_state(cuda_config, verification_passed)
                                
                                self.log("=" * 60)
                                self.log("✓ Installation complete (after version conflict fix)")
                                self.log("=" * 60)
                                return True, ""
                            except Exception as retry_error:
                                self.log(f"  ✗ Retry after fix failed: {retry_error}")
                                # Fall through to cleanup
            
            # IMPORTANT: Only clean up corrupted venv if allow_destroy is True.
            # In repair mode (allow_destroy=False), we preserve the venv and fail with a clear message.
            if self.venv_path.exists() and not should_resume and allow_destroy:
                self.log("Cleaning up corrupted venv...")
                try:
                    shutil.rmtree(self.venv_path, ignore_errors=True)
                    self.log("✓ Corrupted venv removed")
                except Exception as cleanup_error:
                    self.log(f"WARNING: Could not remove venv: {cleanup_error}")
            elif self.venv_path.exists() and not should_resume and not allow_destroy:
                # Venv exists but we can't resume and we're not allowed to destroy
                # This should have been caught earlier, but log it for safety
                self.log("WARNING: Installation failed but venv preserved (repair mode)")
            
            return False, error_msg
    
    def _validate_environment(self):
        """Validate environment before starting"""
        self.log("  Validating environment suitability...")
        # Check wheelhouse exists
        if not self.wheelhouse.exists():
            raise InstallationFailed(f"Wheelhouse not found: {self.wheelhouse}")
        
        # Check Python version
        py_version = sys.version_info
        min_ver = tuple(map(int, self.manifest.get("python_min", "3.10").split(".")))
        max_ver = tuple(map(int, self.manifest.get("python_max", "3.12").split(".")))
        
        if py_version < min_ver or py_version >= (max_ver[0], max_ver[1] + 1):
            raise InstallationFailed(
                f"Python {py_version[0]}.{py_version[1]} not supported. "
                f"Required: >={min_ver[0]}.{min_ver[1]}, <={max_ver[0]}.{max_ver[1]}"
            )
        
        self.log(f"  ✓ Python {py_version[0]}.{py_version[1]} OK")

        # Check for venv locks (Windows specific)
        if sys.platform == 'win32' and self.venv_path.exists():
            self.log("  Checking for environment locks...")
            try:
                # Try to see if we can open a dummy file in the venv
                test_file = self.venv_path / ".repair_lock_test"
                with open(test_file, 'w') as f:
                    f.write('test')
                test_file.unlink()
                self.log("  ✓ Environment is writable")
            except Exception as e:
                self.log(f"  ⚠ Warning: Environment might be locked: {e}")
                self.log("  Please ensure no other training or server processes are running.")

    
    def _destroy_venv(self):
        """Completely destroy existing venv"""
        if not self.venv_path.exists():
            self.log("  No existing venv to remove")
            return
        
        self.log(f"  Removing existing venv: {self.venv_path}")
        
        # Terminate any processes using the venv
        self._terminate_venv_processes()
        
        # Force delete with retries
        for attempt in range(1, 4):
            try:
                if sys.platform == 'win32':
                    # Use Windows command for force delete
                    result = subprocess.run(
                        ['cmd', '/c', 'rmdir', '/S', '/Q', str(self.venv_path)],
                        capture_output=True,
                        text=True,
                        timeout=60,
                        **self.subprocess_flags,
                    )
                    if result.returncode == 0 or not self.venv_path.exists():
                        self.log(f"  ✓ Venv destroyed (attempt {attempt}/3)")
                        return
                else:
                    shutil.rmtree(self.venv_path, ignore_errors=True)
                    if not self.venv_path.exists():
                        self.log(f"  ✓ Venv destroyed (attempt {attempt}/3)")
                        return
            except Exception as e:
                if attempt < 3:
                    self.log(f"  Attempt {attempt} failed: {e}, retrying...")
                    time.sleep(attempt * 2)
                else:
                    raise InstallationFailed(f"Cannot delete venv after 3 attempts: {e}")
        
        # Final check
        if self.venv_path.exists():
            raise InstallationFailed(f"Venv still exists after deletion attempts: {self.venv_path}")
    
    def _terminate_venv_processes(self):
        """Terminate any processes using the venv"""
        if sys.platform != 'win32':
            return  # Only implemented for Windows for now
        
        venv_python = self.venv_path / "Scripts" / "python.exe"
        if not venv_python.exists():
            return
        
        try:
            # Find processes using this Python
            result = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq python.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=5,
                **self.subprocess_flags
            )
            
            # Note: This is a basic implementation
            # More sophisticated process detection would check file handles
            
        except Exception:
            pass  # Best effort
    
    def _check_python_tag_compat(self, venv_python: Path) -> Tuple[bool, str, Optional[str]]:
        """Check whether the venv's Python tag matches the wheelhouse wheels.

        Returns ``(compatible, venv_tag, required_tag)``. ``required_tag``
        is the cpXY string parsed from the first ``.whl`` file in the
        wheelhouse — every well-formed wheel filename is
        ``name-version-pythonTag-abiTag-platform.whl``, and the wheels
        we ship target a single Python so reading any one tells us
        what the venv must be.

        Returns ``(True, venv_tag, None)`` when there are no
        cp-tagged wheels (we can't know what's required).
        """
        # Probe venv Python version → cpXY tag.
        try:
            proc = subprocess.run(
                [
                    str(venv_python),
                    "-c",
                    "import sys; print(f'cp{sys.version_info.major}{sys.version_info.minor}')",
                ],
                capture_output=True,
                text=True,
                timeout=15,
                **self.subprocess_flags,
            )
            venv_tag = (proc.stdout or "").strip()
        except Exception:
            return True, "", None

        if not venv_tag:
            return True, "", None

        required_tag: Optional[str] = None
        try:
            for whl in self.wheelhouse.glob("*.whl"):
                # Filename: <name>-<version>-<pythonTag>-<abiTag>-<platform>.whl
                # E.g. torch-2.5.1+cu121-cp312-cp312-win_amd64.whl
                parts = whl.stem.split("-")
                # Search from the right because version may itself
                # contain dashes after a "+local" tag.
                for token in reversed(parts):
                    if token.startswith("cp") and token[2:].isdigit():
                        required_tag = token
                        break
                if required_tag:
                    break
        except Exception:
            return True, venv_tag, None

        if required_tag is None:
            return True, venv_tag, None
        return venv_tag == required_tag, venv_tag, required_tag

    def _redownload_wheelhouse_for_tag(self, cuda_config: str, venv_tag: str) -> bool:
        """Refresh the wheelhouse so wheels match the venv's cpXY tag.

        Returns True on success. The existing venv is NOT touched —
        only ``self.wheelhouse`` is repopulated. Used by the python-
        tag self-heal when the wheelhouse is full of wheels for the
        wrong Python (e.g. cp312 wheels in a cp311 venv).
        """
        if not (venv_tag.startswith("cp") and len(venv_tag) >= 4 and venv_tag[2:].isdigit()):
            self.log(f"  Cannot parse Python version from venv tag: {venv_tag!r}")
            return False
        digits = venv_tag[2:]
        try:
            python_version = (int(digits[0]), int(digits[1:]))
        except ValueError:
            self.log(f"  Invalid Python version digits in {venv_tag!r}")
            return False

        try:
            from core.wheelhouse import WheelhouseManager
        except Exception as exc:
            self.log(f"  Could not import WheelhouseManager: {exc}")
            return False

        try:
            mgr = WheelhouseManager(self.manifest_path, self.wheelhouse)
        except Exception as exc:
            self.log(f"  Could not construct WheelhouseManager: {exc}")
            return False

        try:
            success, error = mgr.prepare_wheelhouse(
                cuda_config,
                python_version,
                package_versions=getattr(self, "profile_versions", None) or None,
                binary_packages=self.binary_packages or None,
                force_redownload=True,
            )
        except Exception as exc:
            self.log(f"  Wheelhouse prepare failed: {exc}")
            return False

        if not success:
            self.log(f"  Wheelhouse prepare returned failure: {error}")
            return False
        return True

    def _find_bundled_python_for_tag(self, required_tag: str) -> Optional[Path]:
        """Locate a python_runtime/pythonX.Y folder matching ``cpXY``.

        We ship at least 3.11 and 3.12 in the runtime tree; the
        installer's bootstrap may have picked the wrong one. Returns
        the python.exe path or None if no folder matches.
        """
        if not required_tag.startswith("cp") or len(required_tag) < 4:
            return None
        digits = required_tag[2:]
        # cp312 → "3.12"
        if not digits.isdigit():
            return None
        ver = f"{digits[0]}.{digits[1:]}"
        candidate_dir = (
            self.venv_path.parent.parent.parent  # .envs/<key>/.venv → LLM/
            / "python_runtime" / f"python{ver}"
        )
        # Cross-check against an absolute fallback in case wheelhouse
        # / venv structure is non-standard.
        py_exe = candidate_dir / "python.exe"
        if py_exe.exists():
            return py_exe
        # Fallback: look relative to the existing self.python_executable
        try:
            runtime_root = self.python_executable.parent.parent
            alt = runtime_root / f"python{ver}" / "python.exe"
            if alt.exists():
                return alt
        except Exception:
            pass
        return None

    def _create_venv(self) -> Path:
        """
        Create fresh venv.
        
        Returns:
            Path to venv Python executable
        """
        self.log(f"  Creating venv at: {self.venv_path}")
        
        # Check if the Python executable has venv module (self-contained Python may not)
        python_to_use = self.python_executable
        
        # CRITICAL: Use python.exe (not pythonw.exe) for checks to avoid hangs
        # pythonw.exe is a GUI version that can hang on subprocess checks
        check_python = str(self.python_executable)
        if check_python.endswith("pythonw.exe"):
            check_python = check_python.replace("pythonw.exe", "python.exe")
        
        check_venv = subprocess.run(
            [check_python, "-c", "import venv"],
            capture_output=True,
            text=True,
            timeout=30,  # Increased from 10s to 30s to handle slow systems
            **self.subprocess_flags
        )
        
        # If venv module not available, use system Python to create venv
        if check_venv.returncode != 0:
            self.log(f"  Self-contained Python doesn't have venv module, using system Python to create venv")
            # Use system Python (sys.executable) to create the venv
            python_to_use = Path(sys.executable)
            self.log(f"  Using system Python for venv creation: {python_to_use}")
        else:
            self.log(f"  Using Python: {self.python_executable}")
        
        # Create venv with --clear flag
        result = subprocess.run(
            [str(python_to_use), "-m", "venv", str(self.venv_path), "--clear"],
            capture_output=True,
            text=True,
            timeout=120,
            **self.subprocess_flags
        )
        
        if result.returncode != 0:
            raise InstallationFailed(f"Failed to create venv: {result.stderr}")
        
        # Get venv Python path
        if sys.platform == 'win32':
            venv_python = self.venv_path / "Scripts" / "python.exe"
        else:
            venv_python = self.venv_path / "bin" / "python"
        
        if not venv_python.exists():
            raise InstallationFailed(f"Venv created but Python not found at {venv_python}")
        
        self.log(f"  ✓ Venv created")
        
        # Upgrade pip, setuptools, wheel
        self.log("  Upgrading pip, setuptools, wheel...")
        result = subprocess.run(
            [str(venv_python), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
            capture_output=True,
            text=True,
            timeout=300,
            **self.subprocess_flags
        )
        
        if result.returncode != 0:
            self.log(f"  WARNING: pip upgrade had issues: {result.stderr[:200]}")
        else:
            self.log(f"  ✓ pip upgraded")
        
        return venv_python
    
    def _install_packages(self, cuda_config: str, venv_python: Path, skip_installed: bool = False, packages_to_install: List[Tuple[str, str]] = None, binary_packages: dict = None):
        """
        Install all packages from wheelhouse in strict order.
        
        Args:
            cuda_config: CUDA configuration key
            venv_python: Path to venv Python executable
            skip_installed: If True, skip packages that are already installed correctly
            packages_to_install: Optional list of (package_name, version_spec) tuples to install.
                               If provided, only install these packages. If None, install all.
            binary_packages: Optional dict of binary packages to install from wheels.
        """
        # Get dependencies in order
        deps = sorted(self.manifest["core_dependencies"], key=lambda x: x["order"])
        cuda_packages = self.manifest["cuda_configs"][cuda_config]["packages"]
        
        # Use profile versions if available (same as in venv checking phase)
        if self.profile_versions:
            # Profile mode: use exact versions from profile
            cuda_packages_to_install = {k: self.profile_versions.get(k, v) for k, v in cuda_packages.items()}
        else:
            cuda_packages_to_install = cuda_packages
        
        # Create set of packages to install for quick lookup
        packages_to_install_set = None
        if packages_to_install is not None:
            # If empty list, skip all installations
            if len(packages_to_install) == 0:
                self.log("  ✓ All packages already installed correctly - skipping all installations")
                return
            # Normalize package names for lookup
            packages_to_install_set = set()
            for pkg_name, version_spec in packages_to_install:
                pkg_normalized = pkg_name.lower().replace("_", "-")
                packages_to_install_set.add((pkg_normalized, version_spec))
                packages_to_install_set.add((pkg_name, version_spec))  # Also add original name
        
        installed_count = 0
        skipped_count = 0
        total_count = len([d for d in deps if d["version"] != "FROM_CUDA_CONFIG"]) + len(cuda_packages_to_install)
        
        # Install CUDA packages first
        for pkg_name, pkg_version in cuda_packages_to_install.items():
            version_spec = f"=={pkg_version}"
            
            # If packages_to_install is specified, only install those packages
            if packages_to_install_set is not None:
                pkg_normalized = pkg_name.lower().replace("_", "-")
                if (pkg_normalized, version_spec) not in packages_to_install_set and (pkg_name, version_spec) not in packages_to_install_set:
                    continue
            
            # Check if package is already installed (if skip_installed is True)
            extra_reinstall_args: List[str] = []
            if skip_installed:
                self.log(f"  [{installed_count + skipped_count + 1}/{total_count}] Checking {pkg_name}...")
                is_installed, version_matches, is_broken = self._check_package_installed(venv_python, pkg_name, version_spec, check_functionality=True)
                if is_installed and version_matches and not is_broken:
                    skipped_count += 1
                    self.log(f"    ✓ Already installed correctly (version OK, functionality OK)")
                    continue
                elif is_broken:
                    self.log(f"    ⚠ Package is BROKEN (will reinstall)")
                    # Force uninstall first, then reinstall
                    self.log(f"    Uninstalling broken {pkg_name}...")
                    self._uninstall_package(venv_python, pkg_name)
                    # After uninstall, we'll do a clean install (no extra args needed)
                    extra_reinstall_args = []
                elif is_installed and not version_matches:
                    # Force uninstall for wrong version, then clean install
                    self.log(f"    ⚠ Wrong version (will update)")
                    self.log(f"    Uninstalling wrong version of {pkg_name}...")
                    self._uninstall_package(venv_python, pkg_name)
                    extra_reinstall_args = []
                elif not is_installed:
                    self.log(f"    ⚠ Not installed (will install)")
            
            installed_count += 1
            progress = f"[{installed_count + skipped_count}/{total_count}]"
            self.log(f"  {progress} Installing {pkg_name}...")
            
            # Build install command
            success, error = self._install_single_package(
                venv_python=venv_python,
                package_name=pkg_name,
                version_spec=version_spec,
                install_args=["--no-deps"] + extra_reinstall_args  # CUDA packages use --no-deps
            )
            
            if not success:
                raise InstallationFailed(f"Failed to install critical CUDA package {pkg_name}: {error}")
            
            # Special handling for torch - create lock
            if pkg_name == "torch":
                self._create_torch_lock(pkg_version)
        
        # Install binary packages (after torch, before other packages)
        # Use self.binary_packages (stored from install()) instead of parameter
        # Also check parameter in case it was passed directly
        binary_packages_to_use = binary_packages if binary_packages else self.binary_packages
        if binary_packages_to_use:
            self.log("")
            self.log("=" * 60)
            self.log("Installing binary packages from wheels...")
            self.log(f"  Found {len(binary_packages_to_use)} binary package(s) to install: {list(binary_packages_to_use.keys())}")
            self.log("=" * 60)
            # During repair, always install binary packages even if skip_installed is True
            # This ensures they get installed correctly
            if skip_installed and not packages_to_install:
                self.log("  Repair mode: Will verify and install binary packages if needed")
            # Install in correct order: triton -> causal_conv1d -> mamba_ssm
            binary_order = ["triton", "causal_conv1d", "mamba_ssm"]
            for pkg_name in binary_order:
                if pkg_name in binary_packages_to_use:
                    pkg_info = binary_packages_to_use[pkg_name]
                    url = pkg_info.get("url")
                    if url:
                        # Extract wheel filename from URL
                        wheel_filename = url.split("/")[-1]
                        wheel_path = self.wheelhouse / wheel_filename
                        
                        if wheel_path.exists():
                            # For binary packages, always check if they're actually importable
                            # Don't trust the simple version check - try importing them
                            # During repair mode (skip_installed=True and no packages_to_install),
                            # we should ALWAYS reinstall binary packages to ensure they work
                            should_install = True
                            is_broken = False  # Track if package is broken for uninstall step
                            # Check if we're in repair mode
                            is_repair_mode = skip_installed and (packages_to_install is None or len(packages_to_install) == 0)
                            
                            # In repair mode, check if binary packages are broken and reinstall if needed
                            if is_repair_mode:
                                self.log(f"  Checking {pkg_name} functionality...")
                                try:
                                    is_broken = self._check_package_broken(venv_python, pkg_name)
                                    if is_broken:
                                        self.log(f"  ⚠ Repair mode: {pkg_name} is BROKEN (DLL/import failed), will reinstall")
                                        should_install = True
                                    else:
                                        self.log(f"  ✓ Repair mode: {pkg_name} is working, skipping")
                                        should_install = False
                                except Exception as e:
                                    # If check fails, assume broken and reinstall
                                    is_broken = True
                                    self.log(f"  ⚠ Repair mode: {pkg_name} check failed ({e}), will reinstall")
                                    should_install = True
                            elif skip_installed:
                                # Use functional check to detect broken DLLs, not just simple import
                                try:
                                    is_broken = self._check_package_broken(venv_python, pkg_name)
                                    if not is_broken:
                                        # Package is functional - check version if needed
                                        if pkg_name == "triton":
                                            # For triton, also verify version
                                            version_cmd = "import triton; print(triton.__version__)"
                                            ver_result = subprocess.run(
                                                [str(venv_python), "-c", version_cmd],
                                                capture_output=True,
                                                text=True,
                                                timeout=5,
                                                **self.subprocess_flags
                                            )
                                            if ver_result.returncode == 0:
                                                try:
                                                    from packaging import version as pkg_version
                                                    installed_ver = ver_result.stdout.strip()
                                                    if pkg_version.parse(installed_ver) >= pkg_version.parse("3.0.0"):
                                                        self.log(f"  ✓ {pkg_name} is already installed and working (v{installed_ver})")
                                                        should_install = False
                                                except Exception as ver_err:
                                                    self.log(f"  Version check failed for {pkg_name}: {ver_err}, will reinstall")
                                                    should_install = True
                                        else:
                                            # For causal_conv1d and mamba_ssm, functional check already verified CUDA ops
                                            self.log(f"  ✓ {pkg_name} is already installed and working")
                                            should_install = False
                                    else:
                                        # Package is broken (DLL load failed, etc.) - must reinstall
                                        self.log(f"  ⚠ {pkg_name} is broken (DLL/cuda ops failed), will reinstall")
                                        should_install = True
                                except Exception as e:
                                    # If functional check fails, we need to install
                                    is_broken = True
                                    self.log(f"  ⚠ {pkg_name} functional check failed: {e}, will reinstall")
                                    should_install = True
                            
                            if not should_install:
                                continue
                            
                            # If package is broken, uninstall it first to ensure clean reinstall
                            if is_broken:
                                self.log(f"  Uninstalling broken {pkg_name} before reinstall...")
                                uninstall_cmd = [
                                    str(venv_python), "-m", "pip", "uninstall", "-y", pkg_name
                                ]
                                uninstall_result = subprocess.run(
                                    uninstall_cmd,
                                    capture_output=True,
                                    text=True,
                                    timeout=60,
                                    **self.subprocess_flags
                                )
                                if uninstall_result.returncode == 0:
                                    self.log(f"  ✓ Uninstalled {pkg_name}")
                                else:
                                    self.log(f"  ⚠ Uninstall warning (may not have been installed): {uninstall_result.stderr[:200]}")
                            
                            self.log(f"  Installing {pkg_name} from {wheel_filename}...")
                            # Force reinstall if package was broken
                            success, error = self._install_binary_package(venv_python, wheel_path, force_reinstall=is_broken)
                            if success:
                                self.log(f"  ✓ {pkg_name} installed successfully")
                            else:
                                self.log(f"  WARNING: Failed to install binary package {pkg_name}: {error}")
                                # Binary packages are optional - continue even if they fail
                                # They'll be handled at runtime with error messages
                        else:
                            self.log(f"  WARNING: Binary package wheel not found: {wheel_filename}")
                            self.log(f"    Expected at: {wheel_path}")
                            self.log(f"    This means the wheel was not downloaded during wheelhouse preparation.")
                            self.log(f"    Please check if the URL is accessible and the wheelhouse preparation succeeded.")
                            self.log(f"    URL was: {url}")
                            # Try to download it now as fallback
                            self.log(f"    Attempting to download now as fallback...")
                            from core.wheelhouse import WheelhouseManager
                            wheelhouse_mgr = WheelhouseManager(self.manifest_path, self.wheelhouse)
                            download_success, download_error = wheelhouse_mgr._download_binary_package(url, pkg_name)
                            if download_success and wheel_path.exists():
                                self.log(f"    ✓ Downloaded {wheel_filename}, proceeding with installation")
                                # Retry installation
                                success, error = self._install_binary_package(venv_python, wheel_path)
                                if success:
                                    self.log(f"  ✓ {pkg_name} installed successfully")
                                else:
                                    self.log(f"  WARNING: Failed to install binary package {pkg_name}: {error}")
                            else:
                                self.log(f"    ✗ Download failed: {download_error}")
        else:
            if not binary_packages and not self.binary_packages:
                self.log("  No binary packages to install")
        
        # Install core dependencies
        for dep in deps:
            pkg_name = dep["name"]
            
            # Skip platform-specific packages
            if "platform" in dep and dep["platform"] != sys.platform:
                self.log(f"  Skipping {pkg_name} (platform: {dep['platform']})")
                continue
            
            # CUDA stack was already installed in the first loop; don't install it twice.
            if dep["version"] == "FROM_CUDA_CONFIG":
                continue

            # Extract version from spec
            # Use profile version if available (same as in venv checking phase), otherwise use manifest version
            # Normalize package name for lookup (profile might use hyphen or underscore)
            pkg_normalized = pkg_name.lower().replace("_", "-")
            profile_ver = None
            if self.profile_versions:
                # Try both normalized and original name
                if pkg_normalized in self.profile_versions:
                    profile_ver = self.profile_versions[pkg_normalized]
                elif pkg_name in self.profile_versions:
                    profile_ver = self.profile_versions[pkg_name]
                elif pkg_name.replace("-", "_") in self.profile_versions:
                    profile_ver = self.profile_versions[pkg_name.replace("-", "_")]
            
            if profile_ver:
                # Check if it's already a range or exact version
                if any(op in profile_ver for op in [">=", "<=", ">", "<", "!=", ","]):
                    version_spec = profile_ver  # Use range as-is
                else:
                    version_spec = f"=={profile_ver}"  # Exact version
                self.log(f"    Using profile version for {pkg_name}: {version_spec}")
            else:
                version_spec = dep["version"]
                if self.profile_versions:
                    self.log(f"    WARNING: {pkg_name} not found in profile_versions, using manifest version: {version_spec}")
            pkg_version = None  # Will use version_spec directly
            
            # If packages_to_install is specified, only install those packages
            if packages_to_install_set is not None:
                pkg_normalized = pkg_name.lower().replace("_", "-")
                # Check both normalized and original package name
                if (pkg_normalized, version_spec) not in packages_to_install_set:
                    # Also check original name in case it wasn't normalized
                    if (pkg_name, version_spec) not in packages_to_install_set:
                        continue
            
            # Check if package is already installed (if skip_installed is True)
            extra_reinstall_args = []
            if skip_installed:
                self.log(f"  [{installed_count + skipped_count + 1}/{total_count}] Checking {pkg_name}...")
                is_installed, version_matches, is_broken = self._check_package_installed(venv_python, pkg_name, version_spec, check_functionality=True)
                if is_installed and version_matches and not is_broken:
                    skipped_count += 1
                    self.log(f"    ✓ Already installed correctly (version OK, functionality OK)")
                    continue
                elif is_broken:
                    self.log(f"    ⚠ Package is BROKEN (will reinstall)")
                    # Force uninstall first, then reinstall (don't use --force-reinstall which keeps corrupted files)
                    self.log(f"    Uninstalling broken {pkg_name}...")
                    self._uninstall_package(venv_python, pkg_name)
                    # After uninstall, we'll do a clean install (no extra args needed)
                    extra_reinstall_args = []
                    
                    # For torch, ensure all DLL files are cleaned up before reinstall to avoid corruption
                    if pkg_name == "torch":
                        self.log(f"    Cleaning up corrupted torch DLLs before reinstall...")
                        torch_lib = self.venv_path / "Lib" / "site-packages" / "torch" / "lib"
                        if torch_lib.exists():
                            try:
                                for dll_file in torch_lib.glob("*.dll"):
                                    try:
                                        dll_file.unlink()
                                        self.log(f"      Removed: {dll_file.name}")
                                    except Exception as e:
                                        self.log(f"      Warning: Could not remove {dll_file.name}: {e}")
                            except Exception as e:
                                self.log(f"      Warning: DLL cleanup failed: {e}")
                    
                    # For triton, ensure clean reinstall if broken (missing ops sub-module)
                    elif pkg_name in ["triton", "triton-windows"]:
                        self.log(f"    Cleaning up broken triton installation...")
                        triton_path = self.venv_path / "Lib" / "site-packages" / "triton"
                        if triton_path.exists():
                            try:
                                import shutil
                                shutil.rmtree(triton_path, ignore_errors=True)
                                self.log(f"      Removed triton directory for clean reinstall")
                            except Exception as e:
                                self.log(f"      Warning: Could not remove triton directory: {e}")
                    
                    # For peft/transformers, ensure clean reinstall if broken (version compatibility issues)
                    elif pkg_name in ["peft", "transformers"]:
                        self.log(f"    Cleaning up broken {pkg_name} installation...")
                        pkg_path = self.venv_path / "Lib" / "site-packages" / pkg_name
                        if pkg_path.exists():
                            try:
                                import shutil
                                shutil.rmtree(pkg_path, ignore_errors=True)
                                self.log(f"      Removed {pkg_name} directory for clean reinstall")
                            except Exception as e:
                                self.log(f"      Warning: Could not remove {pkg_name} directory: {e}")
                elif is_installed and not version_matches:
                    # Force uninstall for wrong version, then clean install
                    self.log(f"    ⚠ Wrong version (will update)")
                    self.log(f"    Uninstalling wrong version of {pkg_name}...")
                    self._uninstall_package(venv_python, pkg_name)
                    extra_reinstall_args = []
                elif not is_installed:
                    self.log(f"    ⚠ Not installed (will install)")
            
            # Skip optional packages
            # (Could add logic here to check blacklist_deps)
            
            installed_count += 1
            progress = f"[{installed_count + skipped_count}/{total_count}]"
            self.log(f"  {progress} Installing {pkg_name}...")
            
            # Build install command
            # Use version_spec that was calculated above (uses profile version if available)
            success, error = self._install_single_package(
                venv_python=venv_python,
                package_name=pkg_name,
                version_spec=version_spec,  # Use the calculated version_spec (profile or manifest)
                install_args=dep.get("install_args", []) + extra_reinstall_args
            )
            
            if not success:
                if dep.get("critical", False):
                    raise InstallationFailed(f"Failed to install critical package {pkg_name}: {error}")
                else:
                    self.log(f"  WARNING: Failed to install optional package {pkg_name}: {error}")
                    continue
            
            # Special handling for torch - create lock
            if pkg_name == "torch":
                # Extract version from version_spec for lock file
                lock_version = version_spec.replace("==", "").replace(">=", "").replace("<=", "").split(",")[0].split("<")[0].strip()
                self._create_torch_lock(lock_version)
            
            # NOTE: Per-package verification removed - verification happens once at the end
            # This prevents failures when dependencies are installed later in the sequence
        
        if skipped_count > 0:
            self.log(f"  ✓ Installation complete: {installed_count} installed, {skipped_count} skipped (already installed)")
        else:
            self.log(f"  ✓ All packages installed ({installed_count} total)")
        
        # Force metadata cache refresh to ensure packages are immediately discoverable
        # This helps prevent "package not found" errors when checking versions right after install
        try:
            import importlib.metadata
            if hasattr(importlib.metadata, 'distributions'):
                # Trigger metadata cache reload by iterating distributions
                _ = list(importlib.metadata.distributions())
                self.log("  ✓ Metadata cache refreshed")
        except Exception as e:
            self.log(f"  ⚠ Could not refresh metadata cache: {e}")
    
    def _install_binary_package(self, venv_python: Path, wheel_path: Path, force_reinstall: bool = False) -> Tuple[bool, str]:
        """
        Install a binary package from a wheel file.
        
        Args:
            venv_python: Path to venv Python executable
            wheel_path: Path to wheel file
            force_reinstall: If True, use --force-reinstall flag
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        cmd = [
            str(venv_python), "-m", "pip", "install",
            "--no-index",  # Critical: offline only
            "--find-links", str(self.wheelhouse),
            "--no-cache-dir"
            # NO --no-deps: All packages are explicitly listed in profiles
        ]
        
        if force_reinstall:
            cmd.append("--force-reinstall")
        
        cmd.append(str(wheel_path))
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,  # 5 minutes per package
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                error = result.stderr or result.stdout
                return False, error[:500]  # Truncate long errors
            
            return True, ""
            
        except subprocess.TimeoutExpired:
            return False, f"Installation timeout for {wheel_path.name}"
        except Exception as e:
            return False, str(e)
    
    def _install_single_package(
        self, 
        venv_python: Path, 
        package_name: str, 
        version_spec: str,
        install_args: List[str] = None
    ) -> Tuple[bool, str]:
        """
        Install a single package from wheelhouse.
        
        Args:
            venv_python: Path to venv Python
            package_name: Package name
            version_spec: Version specifier (e.g., "==2.5.1+cu124" or ">=1.0.0")
            install_args: Additional pip install arguments
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        if install_args is None:
            install_args = []
        
        # Build pip install command
        cmd = [
            str(venv_python), "-m", "pip", "install",
            "--no-index",  # Critical: offline only
            "--find-links", str(self.wheelhouse),
            "--no-cache-dir"
            # NO --no-deps: All packages are explicitly listed in profiles
        ]
        
        # Add additional args from install_args (like --force-reinstall)
        if install_args:
            for arg in install_args:
                if arg not in cmd:
                    cmd.append(arg)
        
        # Add package specifier
        # Handle version ranges (e.g., ">=0.21.0,<0.24.0") and exact versions
        if version_spec.startswith("==") or version_spec.startswith(">=") or version_spec.startswith("<") or "," in version_spec:
            # Already has operator or is a range - use as-is
            cmd.append(f"{package_name}{version_spec}")
        else:
            # Plain version number - add == prefix
            cmd.append(f"{package_name}=={version_spec}")
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,  # 5 minutes per package
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                error = result.stderr or result.stdout
                error_str = error[:500]  # Truncate long errors
                
                # Check if this is a "missing wheel" error (from versions: none)
                # This means the package isn't in wheelhouse and pip can't query online
                if "from versions: none" in error or "No matching distribution found" in error:
                    # Try to extract missing requirement (name + spec) from error.
                    missing_req = self._extract_missing_package_from_error(error, package_name)
                    if missing_req:
                        attempt_key = str(missing_req).strip().lower().replace("_", "-")
                        attempt_count = self._autoheal_attempts.get(attempt_key, 0) + 1
                        self._autoheal_attempts[attempt_key] = attempt_count

                        # Hard cap to prevent infinite loops.
                        if attempt_count > 2:
                            # Best-effort: include what wheel versions we see for the missing package.
                            wheelhouse_versions_msg = ""
                            try:
                                from core.wheelhouse import WheelhouseManager
                                wheelhouse_mgr_tmp = WheelhouseManager(self.manifest_path, self.wheelhouse)
                                name_only_tmp = str(missing_req)
                                for op in ["==", ">=", "<=", "!=", "~=", ">", "<"]:
                                    if op in name_only_tmp:
                                        name_only_tmp = name_only_tmp.split(op, 1)[0]
                                        break
                                name_only_tmp = name_only_tmp.strip()
                                present_tmp = wheelhouse_mgr_tmp._get_all_wheel_versions(name_only_tmp)
                                wheelhouse_versions_msg = f"\nWheelhouse versions for {name_only_tmp}: {present_tmp}"
                            except Exception:
                                pass
                            return False, (
                                f"Auto-heal retry limit reached for missing requirement: {missing_req}\n"
                                f"Package being installed: {package_name}{version_spec}\n"
                                f"Wheelhouse: {self.wheelhouse}\n"
                                f"{wheelhouse_versions_msg}\n"
                                f"pip error (truncated): {error_str}"
                            )

                        self.log(f"  ⚠ Missing wheel detected: {missing_req}")
                        self.log(f"  🔧 Attempting to download {missing_req} into wheelhouse...")
                        
                        # Try to repair wheelhouse by downloading missing package
                        from core.wheelhouse import WheelhouseManager
                        wheelhouse_mgr = WheelhouseManager(self.manifest_path, self.wheelhouse)
                        python_version = (sys.version_info.major, sys.version_info.minor)

                        # Best-effort: log what versions are currently in wheelhouse for this package.
                        try:
                            name_only = str(missing_req)
                            for op in ["==", ">=", "<=", "!=", "~=", ">", "<"]:
                                if op in name_only:
                                    name_only = name_only.split(op, 1)[0]
                                    break
                            name_only = name_only.strip()
                            present_versions = wheelhouse_mgr._get_all_wheel_versions(name_only)
                            if present_versions:
                                self.log(f"  ⓘ Wheelhouse currently has {name_only} versions: {present_versions}")
                            else:
                                self.log(f"  ⓘ Wheelhouse currently has no wheels for {name_only}")
                        except Exception:
                            pass
                        
                        download_success, download_error = wheelhouse_mgr.download_missing_package(missing_req, python_version)
                        
                        if download_success:
                            self.log(f"  ✓ Downloaded {missing_req} into wheelhouse")
                            self.log(f"  🔄 Retrying installation of {package_name}...")
                            # Retry the install now that wheelhouse has the missing package
                            return self._install_single_package(venv_python, package_name, version_spec, install_args)
                        else:
                            self.log(f"  ⚠ Wheelhouse repair failed for {missing_req}: {download_error}")
                            # If wheelhouse repair failed, try safe online fallback for pure-python deps
                            missing_name = str(missing_req)
                            for op in ["==", ">=", "<=", "!=", "~=", ">", "<"]:
                                if op in missing_name:
                                    missing_name = missing_name.split(op, 1)[0]
                                    break
                            missing_name = missing_name.strip()

                            if self._is_safe_for_online_fallback(missing_name):
                                self.log(f"  🌐 Attempting safe online fallback for {missing_name} (pure-python package)...")
                                # Temporarily allow online index for this pure-python package
                                fallback_cmd = [
                                    str(venv_python), "-m", "pip", "install",
                                    "--no-cache-dir",
                                    missing_name  # Let pip resolve version
                                ]
                                fallback_result = subprocess.run(
                                    fallback_cmd,
                                    capture_output=True,
                                    text=True,
                                    timeout=300,
                                    **self.subprocess_flags
                                )
                                if fallback_result.returncode == 0:
                                    self.log(f"  ✓ Online fallback succeeded for {missing_name}")
                                    self.log(f"  🔄 Retrying installation of {package_name}...")
                                    # Retry original package install
                                    return self._install_single_package(venv_python, package_name, version_spec, install_args)
                                else:
                                    fallback_error = fallback_result.stderr or fallback_result.stdout
                                    self.log(f"  ✗ Online fallback failed for {missing_name}: {fallback_error[:200]}")
                    
                return False, error_str
            
            return True, ""
            
        except subprocess.TimeoutExpired:
            return False, f"Installation timeout for {package_name}"
        except Exception as e:
            return False, str(e)
    
    def _extract_missing_package_from_error(self, error_text: str, current_package: str) -> Optional[str]:
        """
        Extract missing package requirement from pip error message.
        
        IMPORTANT: Return the full requirement (name + version spec) when present,
        e.g. "huggingface-hub>=0.34.0,<1.0" rather than just "huggingface-hub".
        
        Examples:
        - "ERROR: Could not find a version that satisfies the requirement networkx (from torch) (from versions: none)"
        - "ERROR: No matching distribution found for networkx"
        - "ERROR: Could not find a version that satisfies the requirement huggingface-hub>=0.34.0,<1.0 (from transformers) (from versions: none)"
        - "ERROR: No matching distribution found for huggingface-hub>=0.34.0,<1.0"
        """
        import re
        cur_norm = current_package.lower().replace("_", "-").strip()

        def _normalize_req(req: str) -> str:
            # Drop any trailing context like " (from ...)" if present.
            req = (req or "").strip()
            # Drop environment markers (e.g., '; extra == \"http\"') because wheelhouse operates
            # on base requirements; markers depend on the caller context and can break parsing.
            if ";" in req:
                req = req.split(";", 1)[0].strip()
            if "(" in req:
                req = req.split("(", 1)[0].strip()
            # Defensive: remove trailing semicolons if any remain
            req = req.rstrip(";").strip()
            return req

        def _split_name_and_spec(req: str) -> Tuple[str, str]:
            """
            Best-effort parse of 'name[spec]' without requiring packaging.
            Returns (normalized_name, spec_tail).
            """
            req = (req or "").strip()
            # Find first operator char that would start a spec.
            ops = ["==", ">=", "<=", "!=", "~=", ">", "<"]
            idx = None
            for op in ops:
                i = req.find(op)
                if i != -1:
                    idx = i if idx is None else min(idx, i)
            if idx is None:
                name = req
                spec = ""
            else:
                name = req[:idx].strip()
                spec = req[idx:].strip()
            return name.lower().replace("_", "-"), spec

        # Pattern 1: "Could not find a version that satisfies the requirement <REQ> ..."
        # Capture up to first whitespace or ')' and then strip any "(from ...)".
        match = re.search(r"requirement\s+([^\s\)]+)", error_text, re.IGNORECASE)
        if match:
            req = _normalize_req(match.group(1))
            name_norm, _ = _split_name_and_spec(req)
            if name_norm and name_norm != cur_norm:
                # Normalize only the name part; keep the original spec tail if present.
                # We return the full requirement string (name + spec) for version-aware healing.
                if name_norm != req.lower().replace("_", "-"):
                    # If original differs only by underscores/case, rebuild safely:
                    # replace only the name prefix, keep spec as-is.
                    _, spec = _split_name_and_spec(req)
                    return f"{name_norm}{spec}" if spec else name_norm
                return req

        # Pattern 2: "No matching distribution found for <REQ>"
        match = re.search(r"distribution found for\s+([^\s\)]+)", error_text, re.IGNORECASE)
        if match:
            req = _normalize_req(match.group(1))
            name_norm, _ = _split_name_and_spec(req)
            if name_norm and name_norm != cur_norm:
                if name_norm != req.lower().replace("_", "-"):
                    _, spec = _split_name_and_spec(req)
                    return f"{name_norm}{spec}" if spec else name_norm
                return req

        return None
    
    def _is_safe_for_online_fallback(self, package_name: str) -> bool:
        """
        Check if a package is safe for online fallback (pure-python, not GPU/binary).
        
        Args:
            package_name: Package name to check
        
        Returns:
            True if safe for online fallback, False otherwise
        """
        pkg_lower = package_name.lower()
        
        # Never allow online fallback for torch/GPU packages
        forbidden_patterns = ["torch", "triton", "bitsandbytes", "nvidia-", "cuda", "causal_conv1d", "mamba_ssm"]
        if any(pattern in pkg_lower for pattern in forbidden_patterns):
            return False
        
        # Check blacklist
        blacklist = set(pkg.lower().replace("_", "-") for pkg in self.manifest.get("global_blacklist", []))
        if pkg_lower.replace("_", "-") in blacklist:
            return False
        
        # Safe: pure-python packages like networkx, urllib3, certifi, etc.
        return True
    
    def _uninstall_package(self, venv_python: Path, package_name: str) -> Tuple[bool, str]:
        """
        Uninstall a package completely.
        
        Args:
            venv_python: Path to venv Python
            package_name: Package name to uninstall
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        cmd = [
            str(venv_python), "-m", "pip", "uninstall",
            "-y",  # No confirmation
            package_name
        ]
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,  # 1 minute timeout
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                # If package not found, that's OK (already uninstalled)
                if "not installed" in result.stdout.lower() or "not installed" in result.stderr.lower():
                    return True, ""
                error = result.stderr or result.stdout
                return False, error[:500]  # Truncate long errors
            
            return True, ""
            
        except subprocess.TimeoutExpired:
            return False, f"Uninstall timeout for {package_name}"
        except Exception as e:
            return False, str(e)

    def _uninstall_blacklisted_packages(self, venv_python: Path) -> None:
        """
        Uninstall any globally-blacklisted packages from the target venv.
        These packages are known to break imports (e.g., torchao causing transformers failures).
        """
        blacklist = self.manifest.get("global_blacklist", [])
        if not blacklist:
            return

        for pkg in blacklist:
            try:
                # Best-effort uninstall; treat "not installed" as success.
                self.log(f"    Removing blacklisted package if present: {pkg}...")
                self._uninstall_package(venv_python, pkg)
            except Exception:
                # Never fail install because of uninstall issues; main install will surface real errors.
                pass
    
    def _create_torch_lock(self, version: str):
        """Create immutability marker for torch"""
        lock_data = {
            "version": version,
            "timestamp": datetime.now().isoformat(),
            "locked": True,
            "comment": "DO NOT MODIFY - torch version is immutable"
        }
        
        self.torch_lock.write_text(json.dumps(lock_data, indent=2))
        self.log(f"    ✓ Torch lock created: {version}")
    
    def _check_package_broken(self, venv_python: Path, package_name: str) -> bool:
        """
        Check if a package is broken (importable but missing critical attributes or DLL corruption).
        
        Args:
            venv_python: Path to venv Python executable
            package_name: Package name to check
        
        Returns:
            True if package is broken (imports but missing critical attributes or DLL errors), False otherwise
        """
        # Special handling for torch - check critical attributes AND DLL integrity
        if package_name == "torch":
            code = """
try:
    import torch
    import sys
    # Check for critical attributes
    has_version = hasattr(torch, '__version__')
    has_cuda = hasattr(torch, 'cuda')
    has_tensor = hasattr(torch, 'Tensor')
    
    # Try to access CUDA to detect DLL corruption
    dll_ok = True
    try:
        _ = torch.cuda.is_available()  # This will fail if DLLs are corrupted
    except Exception as e:
        dll_ok = False
        print(f'DLL_ERROR: {e}', file=sys.stderr)
    
    if has_version and has_cuda and has_tensor and dll_ok:
        print('OK')
    else:
        print('BROKEN')
except ImportError:
    print('NOT_INSTALLED')
except Exception as e:
    import sys
    print(f'ERROR: {e}', file=sys.stderr)
    print('BROKEN')  # Any other error means it's broken
"""
        elif package_name in ["triton", "triton-windows"]:
            code = """
try:
    import triton
    # Check if triton has basic functionality
    # Note: triton-windows may not have triton.ops (Windows port limitation),
    # so we only check if triton itself can be imported and has core features
    has_version = hasattr(triton, '__version__')
    has_compile = hasattr(triton, 'compile')
    if has_version and has_compile:
        print('OK')
    else:
        print('BROKEN')
except ImportError:
    print('NOT_INSTALLED')
except Exception as e:
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name == "bitsandbytes":
            code = """
try:
    import bitsandbytes
    # Try a simple import that often fails if triton is broken
    from bitsandbytes.nn import Linear8bitLt
    print('OK')
except ImportError:
    print('NOT_INSTALLED')
except Exception as e:
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name == "transformers":
            code = """
try:
    import transformers
    from transformers import PreTrainedModel, AutoModel, AutoTokenizer
    print('OK')
except Exception as e:
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name == "peft":
            code = """
try:
    import peft
    import sys
    # Try importing key classes that are commonly used
    from peft import LoraConfig, get_peft_model
    # Also check that peft can properly import from transformers
    from peft.utils.constants import TRANSFORMERS_MODELS_TO_LORA_TARGET_MODULES_MAPPING
    print('OK')
except ImportError as e:
    # Check if it's the BloomPreTrainedModel error or similar compatibility issue
    error_str = str(e)
    if 'BloomPreTrainedModel' in error_str or 'cannot import name' in error_str:
        print('BROKEN')
    else:
        print('NOT_INSTALLED')
except Exception as e:
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name == "accelerate":
            code = """
try:
    import accelerate
    from accelerate import Accelerator
    print('OK')
except Exception as e:
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name == "datasets":
            code = """
try:
    import datasets
    from datasets import load_dataset
    print('OK')
except Exception as e:
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name == "torchao":
            code = """
try:
    import torchao
    # Check for basic functionality
    from torchao.quantization import quantize_
    print('OK')
except Exception as e:
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name in ["mamba_ssm", "mamba-ssm"]:
            code = """
try:
    import mamba_ssm
    # Try importing the critical CUDA module that fails if DLL is broken
    # This is the exact import that fails with "DLL load failed" when broken
    from mamba_ssm.ops.selective_scan_interface import selective_scan_fn, mamba_inner_fn
    print('OK')
except ImportError as e:
    # DLL load failed or missing module - this is BROKEN
    print('BROKEN')
except Exception as e:
    # Other errors also indicate broken state
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name in ["causal_conv1d", "causal-conv1d"]:
            code = """
try:
    import causal_conv1d
    # Try importing the CUDA operations module
    # This will fail if DLLs are broken or missing
    from causal_conv1d import causal_conv1d_fn, causal_conv1d_update
    print('OK')
except ImportError as e:
    # DLL load failed or missing module - this is BROKEN
    print('BROKEN')
except Exception as e:
    # Other errors also indicate broken state
    print(f'ERROR: {e}')
    print('BROKEN')
"""
        elif package_name == "typing-extensions":
            # typing-extensions package name has hyphen but module name has underscore
            code = """
try:
    import typing_extensions
    print('OK')
except ImportError:
    print('NOT_INSTALLED')
except Exception as e:
    print(f'ERROR: {e}')
"""
        else:
            # For other packages, just check if import works
            # Handle package names with hyphens (convert to underscore for import)
            import_name = package_name.replace("-", "_")
            code = f"""
try:
    import {import_name}
    print('OK')
except ImportError:
    print('NOT_INSTALLED')
except Exception as e:
    print(f'ERROR: {{e}}')
"""
        
        try:
            result = subprocess.run(
                [str(venv_python), "-c", code],
                capture_output=True,
                text=True,
                timeout=30,  # Increased from 10s to 30s to handle slow systems
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                return True  # Consider broken if check fails
            
            output = result.stdout.strip()
            # Check for "BROKEN" anywhere in output (may have warnings before it)
            # Also check stderr in case errors were printed there
            return "BROKEN" in output or output.startswith("ERROR:") or "BROKEN" in (result.stderr or "")
        except subprocess.TimeoutExpired:
            self.log(f"    WARNING: Timeout checking {package_name} functionality (taking >30s)")
            return False  # Don't consider broken if check times out - assume it's OK
        except Exception as e:
            self.log(f"    WARNING: Error checking {package_name} functionality: {e}")
            return False  # Don't consider broken if check fails - assume it's OK
    
    def _check_package_installed(self, venv_python: Path, package_name: str, version_spec: str, check_functionality: bool = False) -> Tuple[bool, bool, bool]:
        """
        Check if a package is installed and if its version matches the requirement.
        
        Args:
            venv_python: Path to venv Python executable
            package_name: Package name to check (pip package name)
            version_spec: Version specifier (e.g., "==4.51.3" or ">=4.51.3,!=4.52.*")
            check_functionality: If True, also check if package is broken (missing critical attributes)
        
        Returns:
            Tuple of (is_installed: bool, version_matches: bool, is_broken: bool)
            If check_functionality is False, is_broken will always be False
        """
        # Package name mappings (pip name -> import name / metadata name)
        # Many packages use hyphens in pip but underscores in imports
        PACKAGE_NAME_MAP = {
            # Binary packages with different names
            "triton-windows": "triton",
            "mamba-ssm": "mamba_ssm",
            
            # Packages with hyphen/underscore differences
            "huggingface-hub": "huggingface_hub",
            "typing-extensions": "typing_extensions",
            "open-clip-torch": "open_clip_torch",
            
            # PySide6 packages (keep as-is, but listed for completeness)
            "PySide6-Essentials": "PySide6.Essentials",
            "PySide6-Addons": "PySide6.Addons",
        }
        
        import_name = PACKAGE_NAME_MAP.get(package_name, package_name)
        
        is_broken = False
        
        # Check functionality first if requested
        if check_functionality:
            is_broken = self._check_package_broken(venv_python, package_name)
            # If broken, we need to reinstall even if metadata says it's installed
            if is_broken:
                return True, False, True  # Installed (metadata), wrong version (broken), is_broken=True
        
        # Check if package is installed using importlib.metadata
        if not METADATA_AVAILABLE:
            # Fallback: try to import the package
            code = f"import {package_name}; print('OK')"
            try:
                result = subprocess.run(
                    [str(venv_python), "-c", code],
                    capture_output=True,
                    text=True,
                    timeout=30,  # Increased from 10s to 30s to handle slow systems
                    **self.subprocess_flags
                )
                is_installed = result.returncode == 0
                if not is_installed:
                    return False, False, False
                # Can't verify version without metadata, assume it matches
                return True, True, False
            except Exception:
                return False, False, False
        
        # Use importlib.metadata to get installed version
        # For binary packages, use import name instead of package name
        check_package_name = import_name if import_name != package_name else package_name
        try:
            code = f"""
import sys
sys.path.insert(0, r'{venv_python.parent.parent / "Lib" / "site-packages"}')
try:
    from importlib.metadata import version, PackageNotFoundError
except ImportError:
    from importlib_metadata import version, PackageNotFoundError

try:
    # Try multiple name variants: pip name, import name, and normalized versions
    # Packages like huggingface-hub can be found as huggingface_hub or huggingface-hub
    names_to_try = ['{package_name}']
    if '{check_package_name}' != '{package_name}':
        names_to_try.append('{check_package_name}')
    # Also try normalized version (replace - with _)
    normalized = '{package_name}'.replace('-', '_')
    if normalized not in names_to_try:
        names_to_try.append(normalized)
    
    installed_ver = None
    for name in names_to_try:
        try:
            installed_ver = version(name)
            break
        except PackageNotFoundError:
            continue
    
    if installed_ver is None:
        print('NOT_FOUND')
    else:
        print(installed_ver)
except Exception as e:
    print(f'ERROR: {{e}}')
"""
            result = subprocess.run(
                [str(venv_python), "-c", code],
                capture_output=True,
                text=True,
                timeout=30,  # Increased from 10s to 30s to handle slow systems
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                return False, False
            
            output = result.stdout.strip()
            if output == "NOT_FOUND" or not output:
                return False, False, False
            
            installed_version = output.strip()
            
            # Check if version matches requirement
            if not PACKAGING_AVAILABLE:
                # Fallback: only support exact == matches
                if version_spec.startswith("=="):
                    required = version_spec[2:].strip()
                    version_matches = installed_version == required
                    return True, version_matches, is_broken
                else:
                    # Can't verify complex specifiers, assume it matches
                    return True, True, is_broken
            
            # Use packaging library for robust version comparison
            try:
                # Handle build tags in both installed version and version_spec
                # e.g., "2.5.1+cu121" -> compare base "2.5.1" and build "+cu121"
                installed_base = installed_version.split("+")[0]
                installed_build = "+" + installed_version.split("+")[1] if "+" in installed_version else ""
                
                # Parse version_spec to extract base version and build tag
                if version_spec.startswith("=="):
                    required_full = version_spec[2:].strip()
                    required_base = required_full.split("+")[0]
                    required_build = "+" + required_full.split("+")[1] if "+" in required_full else ""
                    
                    # Handle wildcard versions (e.g., "==12.6.*")
                    if required_base.endswith(".*"):
                        # Wildcard match: check if installed version starts with the base (without .*)
                        wildcard_base = required_base[:-2]  # Remove ".*"
                        version_matches = installed_base.startswith(wildcard_base + ".") or installed_base == wildcard_base
                        # For wildcards, ignore build tag differences
                        return True, version_matches, is_broken
                    
                    # Both base version and build tag must match for ==
                    version_matches = (installed_base == required_base) and (installed_build == required_build)
                    return True, version_matches, is_broken
                elif version_spec.startswith(">=") or version_spec.startswith("<"):
                    # For range specifiers, only compare base version (ignore build tags)
                    spec = SpecifierSet(version_spec)
                    version_matches = spec.contains(pkg_version.parse(installed_base))
                    return True, version_matches, is_broken
                else:
                    # Complex specifier - use packaging
                    spec = SpecifierSet(version_spec)
                    version_matches = spec.contains(pkg_version.parse(installed_base))
                    return True, version_matches, is_broken
            except Exception:
                # If parsing fails, assume version doesn't match
                return True, False, is_broken
                
        except Exception:
            return False, False, False
    
    def _verify_package_import(self, venv_python: Path, package_name: str) -> Tuple[bool, str]:
        """
        Verify package can be imported.
        
        Args:
            venv_python: Path to venv Python
            package_name: Package to import
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        code = f"import {package_name}; print('{package_name} OK')"
        
        try:
            result = subprocess.run(
                [str(venv_python), "-c", code],
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                return True, ""
            else:
                return False, result.stderr or result.stdout
                
        except Exception as e:
            return False, str(e)
    
    def _is_version_conflict_error(self, error: str) -> bool:
        """
        Check if error is a version conflict that can be fixed.
        
        Args:
            error: Error message from import verification
        
        Returns:
            True if this is a version conflict error
        """
        version_conflict_indicators = [
            "is required",
            "but found",
            "version",
            "ImportError",
            "required for"
        ]
        
        error_lower = error.lower()
        # Check if it mentions version requirements
        has_version_keywords = any(indicator in error_lower for indicator in version_conflict_indicators)
        
        # Check if it's specifically about package versions (not other import errors)
        if has_version_keywords and ("required" in error_lower or "but found" in error_lower):
            return True
        
        return False
    
    def _fix_version_conflicts(self, venv_python: Path, error: str) -> bool:
        """
        Attempt to fix version conflicts by reinstalling problematic packages.
        
        Args:
            venv_python: Path to venv Python
            error: Error message that indicates version conflict
        
        Returns:
            True if fix was attempted and succeeded, False otherwise
        """
        # Parse error to find which package has wrong version
        # Example: "huggingface-hub>=0.34.0,<1.0 is required... but found huggingface-hub==1.2.3"
        
        import re
        
        # Pattern 1: "package>=X,<Y is required... but found package==Z"
        pattern1 = r'(\w+(?:-\w+)*)\s*(?:>=|==|>|<)[\d.,<>=\s]+is required.*?but found\s+(\w+(?:-\w+)*)==([\d.]+)'
        match = re.search(pattern1, error, re.IGNORECASE | re.DOTALL)
        
        if match:
            required_pkg = match.group(1)
            found_pkg = match.group(2)
            wrong_version = match.group(3)
            
            # Use the package name from "but found" as it's more reliable
            pkg_name = found_pkg if found_pkg else required_pkg
        else:
            # Pattern 2: "but found package==version"
            pattern2 = r'but found\s+(\w+(?:-\w+)*)==([\d.]+)'
            match = re.search(pattern2, error, re.IGNORECASE)
            
            if match:
                pkg_name = match.group(1)
                wrong_version = match.group(2)
            else:
                # Pattern 3: Extract package name from error context
                # Look for common package names in the error
                common_packages = ["huggingface-hub", "transformers", "tokenizers", "peft", "datasets"]
                pkg_name = None
                for pkg in common_packages:
                    if pkg.lower() in error.lower():
                        pkg_name = pkg
                        break
                
                if not pkg_name:
                    self.log(f"    ⚠ Could not identify package from error message")
                    return False
        
        # Find correct version (prefer profile if available, fall back to manifest)
        deps = sorted(self.manifest["core_dependencies"], key=lambda x: x["order"])
        dep_info = None
        
        for dep in deps:
            if dep["name"].lower() == pkg_name.lower().replace("_", "-"):
                dep_info = dep
                break
        
        if not dep_info:
            self.log(f"    ⚠ Package {pkg_name} not found in manifest")
            return False

        # Prefer exact profile pin when available, otherwise use manifest (may be flexible).
        normalized_pkg = pkg_name.lower().replace("_", "-")
        version_spec = dep_info["version"]
        if getattr(self, "profile_versions", None):
            # Try both normalized and raw keys.
            if normalized_pkg in self.profile_versions:
                version_spec = f"=={self.profile_versions[normalized_pkg]}"
            elif pkg_name in self.profile_versions:
                version_spec = f"=={self.profile_versions[pkg_name]}"

        self.log(f"    Reinstalling {pkg_name} with correct version {version_spec}...")
        
        # Uninstall wrong version
        uninstall_cmd = [str(venv_python), "-m", "pip", "uninstall", "-y", pkg_name]
        result = subprocess.run(uninstall_cmd, capture_output=True, timeout=60, **self.subprocess_flags)
        
        if result.returncode != 0:
            self.log(f"    ⚠ Uninstall had issues: {result.stderr[:200]}")
        
        # Reinstall with correct version from wheelhouse
        success, install_error = self._install_single_package(
            venv_python=venv_python,
            package_name=pkg_name,
            version_spec=version_spec,
            install_args=dep_info.get("install_args", [])
        )
        
        if success:
            self.log(f"    ✓ {pkg_name} reinstalled with correct version")
            return True
        else:
            self.log(f"    ✗ Failed to reinstall {pkg_name}: {install_error[:200]}")
            return False
    
    def _clear_pycache(self):
        """Clear Python bytecode cache to prevent lazy_loader corruption"""
        site_packages = self.venv_path / "Lib" / "site-packages"
        if not site_packages.exists():
            return
        
        cleared_count = 0
        
        # Remove __pycache__ directories
        for pycache_dir in site_packages.rglob("__pycache__"):
            try:
                shutil.rmtree(pycache_dir, ignore_errors=True)
                cleared_count += 1
            except Exception:
                pass
        
        # Remove .pyc files
        for pyc_file in site_packages.rglob("*.pyc"):
            try:
                pyc_file.unlink()
                cleared_count += 1
            except Exception:
                pass
        
        if cleared_count > 0:
            self.log(f"  ✓ Cleared {cleared_count} cache files/directories")
    
    def _save_install_state(self, cuda_config: str, verification_passed: bool):
        """
        Save installation state to JSON file for resume capability.
        This allows the system to know that installation completed successfully
        and avoid unnecessary repairs on next launch.
        
        Args:
            cuda_config: CUDA configuration used (e.g., 'cu124')
            verification_passed: Whether verification tests passed
        """
        try:
            state = {
                "install_complete": True,
                "install_timestamp": datetime.now().isoformat(),
                "cuda_config": cuda_config,
                "package_versions": self.profile_versions or {},
                "binary_packages": list(self.binary_packages.keys()) if self.binary_packages else [],
                "verification_passed": verification_passed,
                "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "venv_path": str(self.venv_path)
            }
            
            # Save to .install_state.json in LLM directory
            state_file = self.venv_path.parent / ".install_state.json"
            with open(state_file, 'w', encoding='utf-8') as f:
                json.dump(state, f, indent=2)
            
            self.log(f"  ✓ Installation state saved to {state_file.name}")
            
            # Also create marker file for backwards compatibility
            marker = self.venv_path.parent / ".setup_complete"
            marker.touch()
            self.log(f"  ✓ Setup complete marker created")
            
        except Exception as e:
            self.log(f"  ⚠ Warning: Could not save installation state: {e}")
            # Don't fail the installation just because state save failed
    
    def _patch_triton_windows_utils(self, venv_python: Path):
        """
        Patch triton's windows_utils.py to fix CUDA detection issues on Windows.
        This improves type hints and error handling for better reliability.
        
        Args:
            venv_python: Path to venv Python executable
        """
        try:
            # Get site-packages path
            site_packages = self.venv_path / "Lib" / "site-packages"
            windows_utils_path = site_packages / "triton" / "windows_utils.py"
            
            if not windows_utils_path.exists():
                self.log("  ⓘ Triton windows_utils.py not found (triton may not be installed)")
                return
            
            # Read the file
            content = windows_utils_path.read_text(encoding='utf-8')
            original_content = content
            
            # Check if already patched (look for our lenient check function)
            if "check_cuda_pip_headers_only" in content:
                self.log("  ✓ Triton windows_utils.py already patched")
                return
            
            # Apply patch 1: Fix find_winsdk_registry return value (type hint issue)
            # Original: except OSError:\n        return None
            # Fixed: except OSError:\n        return None, None
            if 'except OSError:\n        return None' in content and 'find_winsdk_registry' in content:
                # Find the specific function context
                func_start = content.find('def find_winsdk_registry')
                if func_start > 0:
                    func_section = content[func_start:func_start+2000]  # Get function context
                    if 'except OSError:\n        return None' in func_section:
                        content = content.replace(
                            'except OSError:\n        return None',
                            'except OSError:\n        return None, None',
                            1  # Only replace first occurrence in find_winsdk_registry
                        )
                        self.log("  ✓ Fixed find_winsdk_registry return value (type hint)")
            
            # Apply patch 2: Add lenient CUDA header check function
            if "def check_cuda_pip_headers_only" not in content:
                # Find the end of check_cuda_pip function
                check_cuda_pip_end = content.find("def find_cuda_pip():")
                if check_cuda_pip_end > 0:
                    # Insert the new function before find_cuda_pip
                    new_function = '''

def check_cuda_pip_headers_only(nvidia_base_path):
    """
    Check if CUDA headers are available via pip (more lenient check).
    
    Args:
        nvidia_base_path: Path to nvidia base directory
    
    Returns:
        bool: True if CUDA headers are found, False otherwise
    """
    try:
        cuda_h = nvidia_base_path / "cuda_runtime" / "include" / "cuda.h"
        return cuda_h.exists()
    except Exception:
        return False
'''
                    content = content[:check_cuda_pip_end] + new_function + content[check_cuda_pip_end:]
                    self.log("  ✓ Added check_cuda_pip_headers_only function")
            
            # Apply patch 3: Update find_cuda_pip to use lenient check
            if "check_cuda_pip_headers_only" in content and 'if check_cuda_pip_headers_only(nvidia_base_path):' not in content:
                # Find the return statement in find_cuda_pip
                find_cuda_pip_start = content.find("def find_cuda_pip():")
                if find_cuda_pip_start > 0:
                    # Find the return None, [], [] at the end of find_cuda_pip
                    find_cuda_pip_section = content[find_cuda_pip_start:]
                    
                    # Find where the function ends (before next function or end of file)
                    next_func = find_cuda_pip_section.find("\ndef ", 100)  # Skip past the function signature
                    if next_func > 0:
                        function_body = find_cuda_pip_section[:next_func]
                    else:
                        function_body = find_cuda_pip_section
                    
                    # Find the final return statement
                    final_return_pos = function_body.rfind('    return None, [], []')
                    if final_return_pos > 0 and 'check_cuda_pip_headers_only' not in function_body:
                        # Insert lenient check before the final return
                        new_section = (
                            function_body[:final_return_pos] +
                            '''    # More lenient check: if headers exist, return them even without other components
    # This fixes issues where CUDA runtime is installed but nvcc or libs are missing
    if check_cuda_pip_headers_only(nvidia_base_path):
        try:
            bin_path = str(nvidia_base_path / "cuda_nvcc" / "bin") if (nvidia_base_path / "cuda_nvcc" / "bin").exists() else None
            lib_dirs = [str(nvidia_base_path / "cuda_runtime" / "lib" / "x64")] if (nvidia_base_path / "cuda_runtime" / "lib" / "x64").exists() else []
            return (
                bin_path,
                [str(nvidia_base_path / "cuda_runtime" / "include")],
                lib_dirs,
            )
        except Exception:
            pass  # Fall through to original return

''' +
                            function_body[final_return_pos:]
                        )
                        content = content[:find_cuda_pip_start] + new_section + content[find_cuda_pip_start + len(function_body):]
                        self.log("  ✓ Updated find_cuda_pip with lenient header check")
            
            # Only write if content changed
            if content != original_content:
                windows_utils_path.write_text(content, encoding='utf-8')
                self.log("  ✓ Successfully patched triton windows_utils.py")
            else:
                self.log("  ⓘ Triton windows_utils.py did not need patching")
                
        except Exception as e:
            # Don't fail installation if patching fails - triton may still work
            self.log(f"  ⚠ Warning: Failed to patch triton windows_utils.py: {e}")
            import traceback
            self.log(f"  {traceback.format_exc()}")

    def _bootstrap_triton_windows_toolchain(self, venv_python: Path) -> None:
        """
        Windows-only: run Triton bootstrap steps so the desktop app's functional checks pass.

        This performs the same steps as `SmartInstaller`'s Windows Triton fixes:
        - Generate/copy MinGW import libs (libcuda.a, cuda.lib) into Triton + nvidia/cuda_runtime locations
        - Patch `triton/runtime/build.py` for MinGW python linking
        - Patch `triton/windows_utils.py` to make CUDA header detection more lenient

        We intentionally run this inside the TARGET venv Python so sysconfig paths match that env.
        Failures are non-fatal (some users may not have MinGW tools installed).
        """
        if sys.platform != "win32":
            return

        try:
            llm_dir = Path(__file__).parent.parent
            code = f"""
import sys
from pathlib import Path
llm_dir = Path(r\"{str(llm_dir)}\")
if str(llm_dir) not in sys.path:
    sys.path.insert(0, str(llm_dir))

try:
    from smart_installer import SmartInstaller
    installer = SmartInstaller()
    ok1 = installer._bootstrap_cuda_libs(sys.executable)
    ok2 = installer._patch_triton_runtime_build(sys.executable)
    ok3 = installer._patch_triton_windows_utils(sys.executable)
    # IMPORTANT: this code string is embedded inside an outer f-string in the installer.
    # Avoid inner f-strings / braces here, otherwise the outer f-string will try to
    # interpolate {ok1} at string-construction time (NameError).
    print(\"OK\" if (ok1 and ok2 and ok3) else (\"PARTIAL:%s,%s,%s\" % (ok1, ok2, ok3)))
except Exception as e:
    print(f\"ERROR:{e}\")
"""
            result = subprocess.run(
                [str(venv_python), "-c", code],
                capture_output=True,
                text=True,
                timeout=180,
                **self.subprocess_flags
            )
            out = (result.stdout or "").strip()
            err = (result.stderr or "").strip()

            if result.returncode == 0 and out.startswith("OK"):
                self.log("  ✓ Triton Windows toolchain bootstrap OK")
            elif result.returncode == 0 and out.startswith("PARTIAL"):
                self.log(f"  ⚠ Triton Windows toolchain bootstrap partial: {out}")
                if err:
                    self.log(f"    stderr: {err[:300]}")
            else:
                # Non-fatal: leave as-is; desktop app will show what’s missing.
                self.log("  ⚠ Triton Windows toolchain bootstrap failed (non-fatal)")
                if out:
                    self.log(f"    stdout: {out[:300]}")
                if err:
                    self.log(f"    stderr: {err[:300]}")
        except subprocess.TimeoutExpired:
            self.log("  ⚠ Triton Windows toolchain bootstrap timed out (non-fatal)")
        except Exception as e:
            self.log(f"  ⚠ Triton Windows toolchain bootstrap error (non-fatal): {e}")
    
    def _verify_installation(self, venv_python: Path):
        """
        Run verification checks.
        
        Args:
            venv_python: Path to venv Python
        """
        from .verification import VerificationSystem
        
        # Create verifier
        manifest_path = Path(__file__).parent.parent / "metadata" / "dependencies.json"
        verifier = VerificationSystem(manifest_path, venv_python)
        
        # Run quick verification
        success, error = verifier.run_quick_verify()
        
        if not success:
            raise InstallationFailed(f"Verification failed: {error}")
        
        self.log("  ✓ Verification passed")


def main():
    """Test immutable installer"""
    import sys
    from pathlib import Path
    
    # Test setup
    venv_path = Path(__file__).parent.parent / ".venv_test"
    wheelhouse = Path(__file__).parent.parent / "wheelhouse"
    manifest = Path(__file__).parent.parent / "metadata" / "dependencies.json"
    
    if not wheelhouse.exists():
        print(f"ERROR: Wheelhouse not found at {wheelhouse}")
        print("Run wheelhouse manager first to download wheels")
        sys.exit(1)
    
    if not manifest.exists():
        print(f"ERROR: Manifest not found at {manifest}")
        sys.exit(1)
    
    installer = ImmutableInstaller(venv_path, wheelhouse, manifest)
    
    print("Testing immutable installer...")
    success, error = installer.install("cu124")
    
    if success:
        print("✓ Test passed!")
    else:
        print(f"✗ Test failed: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()

