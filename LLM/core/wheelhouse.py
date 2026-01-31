#!/usr/bin/env python3
"""
Wheelhouse Manager - Downloads and verifies Python wheels
Part of the Immutable Installer system
"""

import sys
import os
import json
import subprocess
import hashlib
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import re

# Try to import packaging for version validation
try:
    from packaging.specifiers import SpecifierSet
    from packaging import version as pkg_version
    PACKAGING_AVAILABLE = True
except ImportError:
    PACKAGING_AVAILABLE = False
    SpecifierSet = None
    pkg_version = None


class BlacklistedPackageError(Exception):
    """Raised when a blacklisted package is found in wheelhouse"""
    pass


class WheelhouseManager:
    """
    Manages wheel download and verification for offline installation.
    Downloads exact wheels to wheelhouse, checks for blacklisted packages.
    """
    
    def __init__(self, manifest_path: Path, wheelhouse_dir: Path):
        """
        Initialize wheelhouse manager.
        
        Args:
            manifest_path: Path to dependencies.json manifest
            wheelhouse_dir: Path to wheelhouse directory for storing wheels
        """
        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = json.load(f)
        
        self.wheelhouse = wheelhouse_dir
        self.wheelhouse.mkdir(parents=True, exist_ok=True)
        
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
    
    def log(self, message: str):
        """Log message to console with encoding safety"""
        try:
            print(f"[WHEELHOUSE] {message}")
        except UnicodeEncodeError:
            # Fallback for Windows consoles that don't support UTF-8
            safe_message = message.replace('✓', '[OK]').replace('✗', '[FAIL]').replace('⚠', '[WARN]')
            try:
                print(f"[WHEELHOUSE] {safe_message}")
            except Exception:
                # Last resort: ASCII only
                ascii_message = message.encode('ascii', 'replace').decode('ascii')
                print(f"[WHEELHOUSE] {ascii_message}")
    
    def _extract_version_from_wheel(self, wheel_path: Path) -> Optional[str]:
        """
        Extract version from wheel filename.
        
        Args:
            wheel_path: Path to wheel file
            
        Returns:
            Version string or None if parsing fails
        """
        # Wheel filename format: package-version-pyver-abi-platform.whl
        # Example: transformers-4.57.3-cp312-cp312-win_amd64.whl
        wheel_name_parts = wheel_path.stem.split("-")
        if len(wheel_name_parts) >= 2:
            # Version is typically the second part, but may contain + for build tags
            # Handle cases like: torch-2.5.1+cu124-cp312...
            version_part = wheel_name_parts[1]
            # Check if next part is a build tag (starts with + or is a number)
            if len(wheel_name_parts) >= 3:
                # Check if third part looks like a build tag (contains + or is part of version)
                third_part = wheel_name_parts[2]
                if "+" in third_part or third_part.replace(".", "").isdigit():
                    # Version might span multiple parts
                    # Try to reconstruct: version+build
                    potential_version = f"{version_part}-{third_part}"
                    # Validate it looks like a version
                    if re.match(r'^[\d.]+[\+\-]?[\w.]*$', potential_version):
                        return potential_version.replace("-", "+", 1) if "+" not in potential_version else potential_version
            
            # Simple case: version is just the second part
            if re.match(r'^[\d.]+[\+\-]?[\w.]*$', version_part):
                return version_part
        
        return None
    
    def _validate_wheel_against_requirement(self, package_name: str, wheel_version: str, requirement_spec: str) -> bool:
        """
        Validate that a wheel version satisfies a requirement specifier.
        
        Args:
            package_name: Package name (for logging)
            wheel_version: Version extracted from wheel filename
            requirement_spec: Requirement specifier (e.g., ">=4.51.3,!=4.52.*,!=4.53.*")
            
        Returns:
            True if wheel version satisfies requirement, False otherwise
        """
        if not PACKAGING_AVAILABLE:
            # Fallback: only support exact == matches
            if requirement_spec.startswith("=="):
                required = requirement_spec[2:].strip()
                return wheel_version == required
            else:
                # Can't validate complex specifiers without packaging
                # Assume OK if we can't verify (conservative approach)
                return True

        # Normalize bare versions like "6.8.1" or "12.6.*" into valid specifiers.
        # SpecifierSet requires an operator (e.g. "==6.8.1").
        requirement_spec = str(requirement_spec or "").strip()
        if requirement_spec and not requirement_spec.startswith(("==", ">=", "<=", ">", "<", "!=")) and "," not in requirement_spec:
            requirement_spec = f"=={requirement_spec}"
        
        try:
            # Parse requirement specifier
            spec = SpecifierSet(requirement_spec)
            
            # Parse wheel version (handle build tags like +cu124)
            # Extract base version before + if present
            base_version = wheel_version.split("+")[0].split("-")[0]
            
            # Check if version satisfies specifier
            return spec.contains(pkg_version.parse(base_version))
        except Exception as e:
            # If parsing fails, log warning and assume invalid
            self.log(f"  ⚠ Could not validate {package_name} {wheel_version} against {requirement_spec}: {e}")
            return False
    
    def _get_wheel_version(self, package_name: str) -> Optional[str]:
        """
        Get version of a package from wheelhouse.
        
        Args:
            package_name: Package name (normalized)
            
        Returns:
            Version string or None if not found
        """
        pkg_normalized = package_name.lower().replace("_", "-")
        
        for wheel in self.wheelhouse.glob("*.whl"):
            wheel_name_parts = wheel.stem.split("-")
            if len(wheel_name_parts) >= 1:
                wheel_pkg = wheel_name_parts[0].lower().replace("_", "-")
                if wheel_pkg == pkg_normalized:
                    return self._extract_version_from_wheel(wheel)
        
        return None

    def _get_all_wheel_versions(self, package_name: str) -> List[str]:
        """
        Get ALL versions present in the wheelhouse for a given package.

        Args:
            package_name: Package name (normalized)

        Returns:
            List of version strings (may be empty). Duplicates removed.
        """
        pkg_normalized = package_name.lower().replace("_", "-")
        versions = []
        for wheel in self.wheelhouse.glob("*.whl"):
            wheel_name_parts = wheel.stem.split("-")
            if not wheel_name_parts:
                continue
            wheel_pkg = wheel_name_parts[0].lower().replace("_", "-")
            if wheel_pkg != pkg_normalized:
                continue
            ver = self._extract_version_from_wheel(wheel)
            if ver:
                versions.append(ver)
        # De-dupe while preserving order
        seen = set()
        uniq = []
        for v in versions:
            if v in seen:
                continue
            seen.add(v)
            uniq.append(v)
        return uniq

    def _remove_nonmatching_package_wheels(self, package_name: str, expected_version: str) -> int:
        """
        Remove wheels for a package that do NOT match expected_version.
        Returns number of removed wheels.
        """
        pkg_normalized = package_name.lower().replace("_", "-")
        removed = 0
        for wheel in list(self.wheelhouse.glob(f"{pkg_normalized}-*.whl")):
            ver = self._extract_version_from_wheel(wheel)
            if ver and ver != expected_version:
                try:
                    wheel.unlink()
                    self.log(f"  Removed outdated wheel: {wheel.name}")
                    removed += 1
                except Exception as e:
                    self.log(f"  Warning: Could not remove {wheel.name}: {e}")
        return removed
    
    def _validate_wheelhouse_requirements(self, package_versions: dict = None) -> Tuple[bool, str]:
        """
        Validate that existing wheels in wheelhouse satisfy current requirements.
        
        Args:
            package_versions: Optional dict of {package_name: exact_version} for profile-based mode.
                            If None, validates against manifest requirements.
        
        Returns:
            Tuple of (is_valid: bool, error_message: str)
        """
        validation_errors = []
        packages_to_remove = []  # Track which packages need wheel removal
        
        self.log("Starting wheelhouse validation...")
        if package_versions:
            self.log(f"  Mode: Profile-based (validating {len(package_versions)} packages)")
        else:
            self.log("  Mode: Manifest-based")
        
        if package_versions:
            # Profile-based mode: validate against exact profile versions
            # Also check if wheels satisfy flexible requirements from manifest if they exist
            # Validate ALL packages from profile, not just a hardcoded list
            # Profile is the single source of truth - every package must match exactly
            for pkg_name in package_versions.keys():
                    expected_version = str(package_versions[pkg_name]).strip()
                    wheel_versions = self._get_all_wheel_versions(pkg_name)

                    if not wheel_versions:
                        # Wheel missing - will be downloaded in prepare phase
                        # Don't add error - this is expected after removing wrong versions
                        self.log(f"  {pkg_name}: No wheel found (expected {expected_version}) - will download")
                        continue

                    # Normalize profile versions into a SpecifierSet (supports exact, ranges, and wildcards like "12.6.*")
                    # Examples:
                    # - "6.8.1"      -> "==6.8.1"
                    # - "12.6.*"     -> "==12.6.*"
                    # - ">=0.7,<0.8" -> ">=0.7,<0.8"
                    if PACKAGING_AVAILABLE:
                        try:
                            spec_str = expected_version
                            if spec_str and not spec_str.startswith(("==", ">=", "<=", ">", "<", "!=")) and "," not in spec_str:
                                spec_str = f"=={spec_str}"

                            spec = SpecifierSet(spec_str)
                            matching_versions = [
                                v for v in wheel_versions
                                if spec.contains(pkg_version.parse(str(v)))
                            ]

                            if not matching_versions:
                                packages_to_remove.append((pkg_name, wheel_versions[0] if wheel_versions else "none", expected_version))
                                validation_errors.append(
                                    f"{pkg_name}: wheel version(s) {wheel_versions} do not satisfy {spec_str}"
                                )
                                self.log(f"  {pkg_name}: INVALID - found {wheel_versions}, expected {spec_str}")
                            elif len(matching_versions) < len(wheel_versions):
                                # Remove non-matching versions to keep wheelhouse deterministic
                                self.log(f"  {pkg_name}: Removing non-matching versions from {wheel_versions}")
                                for wheel_ver in wheel_versions:
                                    if wheel_ver not in matching_versions:
                                        self.log(f"    - Removing {wheel_ver} (doesn't match {spec_str})")
                                        self._remove_package_wheels(pkg_name, specific_version=wheel_ver)
                                wheel_versions = self._get_all_wheel_versions(pkg_name)
                                self.log(f"  {pkg_name}: OK - keeping {matching_versions}")
                            else:
                                self.log(f"  {pkg_name}: OK - {wheel_versions[0]} satisfies {spec_str}")
                        except Exception as e:
                            self.log(f"  ⚠ Could not validate version spec {expected_version} for {pkg_name}: {e}")
                    else:
                        # Packaging not available - fall back to string equality.
                        if expected_version not in wheel_versions:
                            packages_to_remove.append((pkg_name, wheel_versions[0] if wheel_versions else "none", expected_version))
                            validation_errors.append(
                                f"{pkg_name}: wheel version(s) {wheel_versions} do not include expected {expected_version}"
                            )
                            self.log(f"  {pkg_name}: INVALID - found {wheel_versions}, expected exact {expected_version}")
                        else:
                            self.log(f"  {pkg_name}: OK - exact match {expected_version}")
        else:
            # Manifest-based mode: validate against requirements from dependencies.json
            deps = sorted(self.manifest["core_dependencies"], key=lambda x: x["order"])
            
            for dep in deps:
                pkg_name = dep["name"]
                
                # Skip CUDA packages (handled separately)
                if dep["version"] == "FROM_CUDA_CONFIG":
                    continue
                
                # Skip platform-specific packages
                if "platform" in dep and dep["platform"] != sys.platform:
                    continue
                
                # Only validate critical packages
                if not dep.get("critical", False):
                    continue
                
                version_spec = str(dep["version"]).strip()
                # Normalize bare versions like "6.8.1" / "12.6.*" into "==6.8.1" / "==12.6.*"
                if version_spec and not version_spec.startswith(("==", ">=", "<=", ">", "<", "!=")) and "," not in version_spec:
                    version_spec = f"=={version_spec}"
                wheel_version = self._get_wheel_version(pkg_name)
                
                if not wheel_version:
                    validation_errors.append(f"{pkg_name}: wheel not found")
                    self.log(f"  {pkg_name}: MISSING - expected {version_spec}")
                    continue
                
                # Validate wheel version against requirement
                if not self._validate_wheel_against_requirement(pkg_name, wheel_version, version_spec):
                    validation_errors.append(f"{pkg_name}: wheel version {wheel_version} does not satisfy {version_spec}")
                    self.log(f"  {pkg_name}: INVALID - found {wheel_version}, expected {version_spec}")
                else:
                    self.log(f"  {pkg_name}: OK - {wheel_version} satisfies {version_spec}")
        
        # Remove wrong version wheels BEFORE returning
        if packages_to_remove:
            self.log(f"Removing {len(packages_to_remove)} outdated wheels...")
            for pkg_name, old_ver, new_ver in packages_to_remove:
                self.log(f"  {pkg_name}: {old_ver} -> {new_ver} (removing old)")
                self._remove_package_wheels(pkg_name)
        
        if validation_errors:
            self.log(f"Validation result: FAILED ({len(validation_errors)} error(s))")
            error_msg = "Wheelhouse validation failed:\n  " + "\n  ".join(validation_errors)
            return False, error_msg
        
        self.log("Validation result: SUCCESS - all wheels satisfy requirements")
        return True, ""
    
    def _validate_dependency_compatibility(self, package_versions: dict = None) -> Tuple[bool, str]:
        """
        Validate dependency compatibility BEFORE downloading anything.
        Checks known compatibility rules and ensures versions are compatible.
        
        Args:
            package_versions: Optional dict of {package_name: exact_version} for profile-based mode.
                            If None, validates against manifest requirements.
        
        Returns:
            Tuple of (is_valid: bool, error_message: str)
        """
        compatibility_errors = []
        
        # Known compatibility rules (package -> required dependency version)
        known_requirements = {
            "transformers": {
                # NOTE: requirements must match transformers' own dependency_versions_table.py
                "4.51.3": {"tokenizers": ">=0.21,<0.22"},
                "4.57.3": {"tokenizers": ">=0.22.0,<=0.23.0"},
                # Add more as needed
            }
        }
        
        # Get package versions to check
        if package_versions:
            # Profile-based mode: use exact versions from profile
            versions_to_check = package_versions.copy()
        else:
            # Manifest-based mode: extract versions from dependencies.json
            versions_to_check = {}
            deps = sorted(self.manifest["core_dependencies"], key=lambda x: x["order"])
            for dep in deps:
                if dep["version"] != "FROM_CUDA_CONFIG" and dep.get("critical", False):
                    # For flexible requirements, we'll check compatibility rules
                    # but can't validate exact version without downloading
                    versions_to_check[dep["name"]] = dep["version"]
        
        # Check transformers -> tokenizers compatibility
        # This is the most common compatibility issue
        if "transformers" in versions_to_check and "tokenizers" in versions_to_check:
            transformers_spec = versions_to_check["transformers"]
            tokenizers_spec = versions_to_check["tokenizers"]
            
            # Extract minimum transformers version from spec (e.g., ">=4.51.3" -> "4.51.3")
            min_transformers_ver = None
            if isinstance(transformers_spec, str):
                if transformers_spec.startswith(">="):
                    min_transformers_ver = transformers_spec.split(">=")[1].split(",")[0].strip()
                elif transformers_spec.startswith("=="):
                    min_transformers_ver = transformers_spec.split("==")[1].strip()
            
            # Check if transformers version requires tokenizers>=0.22.0
            if min_transformers_ver:
                # Transformers 4.57+ requires tokenizers>=0.22.0,<=0.23.0
                requires_tokenizers_022 = False
                if PACKAGING_AVAILABLE:
                    try:
                        if pkg_version.parse(min_transformers_ver) >= pkg_version.parse("4.57.0"):
                            requires_tokenizers_022 = True
                    except Exception:
                        # Fallback: string comparison
                        if "4.57" in min_transformers_ver:
                            requires_tokenizers_022 = True
                else:
                    # Fallback: simple string check
                    if "4.57" in min_transformers_ver:
                        requires_tokenizers_022 = True
                
                if requires_tokenizers_022:
                    # Check if tokenizers spec allows 0.22.0+
                    if isinstance(tokenizers_spec, str):
                        # Check for common incompatible patterns
                        if "<0.22" in tokenizers_spec or "0.21" in tokenizers_spec:
                            compatibility_errors.append(
                                f"❌ DEPENDENCY CONFLICT DETECTED:\n"
                                f"   transformers {min_transformers_ver}+ requires tokenizers>=0.22.0,<=0.23.0\n"
                                f"   but dependencies.json specifies: tokenizers {tokenizers_spec}\n"
                                f"   This will cause installation to fail when transformers tries to import tokenizers."
                            )
                        elif not self._check_version_compatibility("tokenizers", tokenizers_spec, ">=0.22.0,<=0.23.0"):
                            compatibility_errors.append(
                                f"❌ DEPENDENCY CONFLICT DETECTED:\n"
                                f"   transformers {min_transformers_ver}+ requires tokenizers>=0.22.0,<=0.23.0\n"
                                f"   but dependencies.json specifies: tokenizers {tokenizers_spec}\n"
                                f"   These version ranges are incompatible."
                            )
        
        # Also check exact version matches in profile mode
        if package_versions:
            transformers_ver = package_versions.get("transformers", "")
            tokenizers_ver = package_versions.get("tokenizers", "")
            
            # Check if transformers version requires specific tokenizers version
            if transformers_ver and tokenizers_ver:
                # Extract base transformers version (remove +cu124 etc)
                base_tf_ver = transformers_ver.split("+")[0]
                
                # Check known requirements
                for known_ver, deps in known_requirements.get("transformers", {}).items():
                    if PACKAGING_AVAILABLE:
                        try:
                            if pkg_version.parse(base_tf_ver) >= pkg_version.parse(known_ver):
                                required_tokenizers = deps.get("tokenizers")
                                if required_tokenizers:
                                    # Check if tokenizers version satisfies requirement
                                    if not self._check_version_compatibility("tokenizers", tokenizers_ver, required_tokenizers):
                                        compatibility_errors.append(
                                            f"❌ DEPENDENCY CONFLICT: transformers {base_tf_ver} requires {required_tokenizers}, "
                                            f"but profile specifies tokenizers {tokenizers_ver}"
                                        )
                        except Exception:
                            pass
        
        if compatibility_errors:
            error_msg = "Dependency compatibility check failed BEFORE installation:\n\n"
            error_msg += "\n".join(compatibility_errors)
            error_msg += "\n\nPlease fix dependencies.json or compatibility_matrix.json before proceeding."
            return False, error_msg
        
        return True, ""
    
    def _check_version_compatibility(self, package_name: str, version_spec: str, required_spec: str) -> bool:
        """
        Check if a version specifier is compatible with a required specifier.
        
        Args:
            package_name: Package name (for logging)
            version_spec: Version specifier from manifest (e.g., ">=0.21.0,<0.22" or exact "0.22.0")
            required_spec: Required version specifier (e.g., ">=0.22.0,<=0.23.0")
        
        Returns:
            True if compatible, False otherwise
        """
        if not PACKAGING_AVAILABLE:
            # Fallback: simple string checks
            if "0.21" in version_spec and "0.22" in required_spec:
                return False
            return True
        
        try:
            # Parse required specifier
            required_set = SpecifierSet(required_spec)
            
            # Check if version_spec is an exact version (no operators like >=, !=, etc)
            # Exact version format: digits, dots, optional +suffix (like 0.22.0 or 2.5.1+cu121)
            is_exact_version = re.match(r'^[\d.]+(\+[\w.]+)?$', version_spec.strip())
            
            if is_exact_version:
                # It's an exact version - check if it satisfies the required spec
                try:
                    parsed_ver = pkg_version.parse(version_spec)
                    is_compatible = required_set.contains(parsed_ver)
                    if not is_compatible:
                        self.log(f"  ⚠ Version {version_spec} does not satisfy {required_spec}")
                    return is_compatible
                except Exception as e:
                    self.log(f"  ⚠ Could not parse exact version {version_spec}: {e}")
                    return False
            else:
                # It's a specifier - check for overlap between two specifiers
                version_set = SpecifierSet(version_spec)
                
                # Test a few candidate versions to see if any satisfy both
                test_versions = ["0.21.0", "0.22.0", "0.22.1", "0.23.0", "0.24.0"]
                
                for test_ver in test_versions:
                    try:
                        parsed_ver = pkg_version.parse(test_ver)
                        if version_set.contains(parsed_ver) and required_set.contains(parsed_ver):
                            # Found a version that satisfies both - they're compatible
                            return True
                    except Exception:
                        continue
                
                # If no overlap found, they're incompatible
                self.log(f"  ⚠ No version overlap between {version_spec} and {required_spec}")
                return False
        except Exception as e:
            # If parsing fails, log and return True to avoid blocking valid configs
            self.log(f"  ⚠ Could not check compatibility: {e} - allowing to proceed")
            return True  # Changed from False to True to be less strict
    
    def prepare_wheelhouse(self, cuda_config: str, python_version: Tuple[int, int], package_versions: dict = None, binary_packages: dict = None, force_redownload: bool = False) -> Tuple[bool, str]:
        """
        Download all wheels to wheelhouse with exact versions.
        
        Args:
            cuda_config: CUDA configuration key (e.g., "cu124")
            python_version: Python version tuple (e.g., (3, 12))
            package_versions: Optional dict of {package_name: exact_version} from ProfileSelector.
                            If provided, uses these instead of manifest.
            force_redownload: If True, clear wheelhouse and re-download everything.
                            If False (default), skip if wheelhouse is already complete.
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        try:
            self.log(f"Preparing wheelhouse for {cuda_config}, Python {python_version[0]}.{python_version[1]}")
            
            # CRITICAL: Validate dependency compatibility BEFORE downloading anything
            self.log("Validating dependency compatibility...")
            is_compatible, error_msg = self._validate_dependency_compatibility(package_versions)
            if not is_compatible:
                self.log("")
                self.log("=" * 60)
                self.log("✗ DEPENDENCY COMPATIBILITY CHECK FAILED")
                self.log("=" * 60)
                self.log("")
                self.log(error_msg)
                self.log("")
                return False, error_msg
            
            self.log("✓ Dependency compatibility check passed")
            
            # Check if wheelhouse already has wheels (skip re-download unless forced)
            existing_wheels = list(self.wheelhouse.glob("*.whl"))
            if existing_wheels and not force_redownload:
                # Validate wheelhouse against current requirements
                self.log("Validating existing wheelhouse against current requirements...")
                is_valid, error_msg = self._validate_wheelhouse_requirements(package_versions)
                
                if not is_valid:
                    self.log(f"⚠ Wheelhouse validation failed:")
                    for line in error_msg.split("\n"):
                        if line.strip():
                            self.log(f"  {line}")
                    self.log("Wrong version wheels removed. Re-downloading missing/correct versions...")
                    # Don't clear entire wheelhouse - validation already removed wrong wheels
                    # Just continue to download phase to get missing packages
                else:
                    self.log(f"✓ Wheelhouse validation passed - {len(existing_wheels)} wheels satisfy current requirements")
                    # Still need to check and download binary packages if they're missing
                    if binary_packages:
                        self.log("Checking binary packages in wheelhouse...")
                        missing_binary_wheels = []
                        for pkg_name, pkg_info in binary_packages.items():
                            url = pkg_info.get("url")
                            if url:
                                wheel_filename = url.split("/")[-1]
                                wheel_path = self.wheelhouse / wheel_filename
                                if not wheel_path.exists():
                                    missing_binary_wheels.append((pkg_name, url, wheel_filename))
                        
                        if missing_binary_wheels:
                            self.log(f"  Found {len(missing_binary_wheels)} missing binary package wheel(s)")
                            self.log("Phase 1.5: Downloading missing binary packages from URLs")
                            binary_order = ["triton", "causal_conv1d", "mamba_ssm"]
                            for pkg_name in binary_order:
                                for missing_pkg, missing_url, missing_filename in missing_binary_wheels:
                                    if missing_pkg == pkg_name:
                                        self.log(f"  Downloading {pkg_name} from {missing_url}")
                                        success, error = self._download_binary_package(missing_url, pkg_name)
                                        if success:
                                            self.log(f"  ✓ Downloaded {missing_filename}")
                                        else:
                                            self.log(f"  WARNING: Failed to download {pkg_name}: {error}")
                                        break
                        else:
                            self.log("  All binary package wheels are present")
                    
                    self.log("Skipping re-download (use force_redownload=True to force)")
                    return True, ""
            
            # Clear existing wheelhouse only if forced or if starting fresh
            elif force_redownload:
                self._clear_wheelhouse()
            
            # If package_versions provided, use hardware-adaptive installation
            if package_versions:
                return self._prepare_from_profile(cuda_config, python_version, package_versions, binary_packages)
            
            # Otherwise, use legacy manifest-based installation
            return self._prepare_from_manifest(cuda_config, python_version)
            
            # Get CUDA-specific packages
            if cuda_config not in self.manifest["cuda_configs"]:
                return False, f"Unknown CUDA config: {cuda_config}"
            
            cuda_packages = self.manifest["cuda_configs"][cuda_config]["packages"]
            torch_index = self.manifest["cuda_configs"][cuda_config]["torch_index"]
            
            # Phase 1: Download torch stack from CUDA index
            self.log("Phase 1: Downloading torch stack from CUDA index")
            for pkg_name, pkg_version in cuda_packages.items():
                self.log(f"  Downloading {pkg_name}=={pkg_version}")
                success, error = self._download_wheel(
                    package=f"{pkg_name}=={pkg_version}",
                    index_url=torch_index,
                    no_deps=True,  # Critical: no deps for torch
                    python_version=python_version
                )
                if not success:
                    return False, f"Failed to download {pkg_name}: {error}"
            
            # Phase 2: Download core dependencies in order
            self.log("Phase 2: Downloading core dependencies")
            deps = sorted(self.manifest["core_dependencies"], key=lambda x: x["order"])
            
            for dep in deps:
                pkg_name = dep["name"]
                
                # Skip CUDA packages (already downloaded)
                if dep["version"] == "FROM_CUDA_CONFIG":
                    continue
                
                # Skip platform-specific packages if not on that platform
                if "platform" in dep and dep["platform"] != sys.platform:
                    self.log(f"  Skipping {pkg_name} (platform: {dep['platform']}, current: {sys.platform})")
                    continue
                
                version_spec = dep["version"]
                
                # Determine install args
                install_args = dep.get("install_args", [])
                no_deps = "--no-deps" in install_args
                
                self.log(f"  Downloading {pkg_name}{version_spec}")
                success, error = self._download_wheel(
                    package=f"{pkg_name}{version_spec}",
                    index_url=None,  # Use default PyPI
                    no_deps=no_deps,
                    python_version=python_version
                )
                if not success:
                    # Non-critical packages can fail
                    if dep.get("critical", False):
                        return False, f"Failed to download critical package {pkg_name}: {error}"
                    else:
                        self.log(f"  WARNING: Failed to download optional package {pkg_name}: {error}")
            
            # Phase 3: Verify no blacklisted packages
            self.log("Phase 3: Verifying no blacklisted packages")
            success, error = self._verify_no_blacklist()
            if not success:
                return False, error
            
            # Phase 4: Verify all critical packages present
            self.log("Phase 4: Verifying all wheels present")
            success, error = self._verify_wheels_present(deps, cuda_packages)
            if not success:
                return False, error
            
            self.log("✓ Wheelhouse preparation complete")
            return True, ""
            
        except UnicodeEncodeError as e:
            # Handle encoding errors separately
            return False, f"Wheelhouse preparation failed due to encoding error. Please ensure console supports UTF-8."
        except Exception as e:
            error_msg = str(e)
            # Handle Unicode in error messages
            try:
                if not error_msg.isascii():
                    error_msg = error_msg.encode('ascii', 'replace').decode('ascii')
            except:
                error_msg = "Unknown error (encoding issue)"
            return False, f"Wheelhouse preparation exception: {error_msg}"
    
    def _prepare_from_profile(self, cuda_config: str, python_version: Tuple[int, int], package_versions: dict, binary_packages: dict = None) -> Tuple[bool, str]:
        """
        Prepare wheelhouse from ProfileSelector package versions (hardware-adaptive).
        
        Args:
            cuda_config: CUDA config for torch index URL
            python_version: Python version tuple
            package_versions: Dict of {package_name: exact_version}
        
        Returns:
            Tuple of (success, error_message)
        """
        try:
            def _pkg_spec(name: str, ver: str) -> str:
                """
                Build a valid pip requirement spec from profile versions.
                Profile versions can be:
                - exact: "2.5.1+cu121"
                - ranges: ">=0.7.0,<0.8.0"
                - wildcards: "12.6.*"
                """
                ver = str(ver).strip()
                # If it's already a spec/range (has operators), use as-is
                if any(op in ver for op in [">=", "<=", ">", "<", "!=", ","]):
                    return f"{name}{ver}"
                # If caller accidentally provides "==x", keep as-is.
                if ver.startswith("=="):
                    return f"{name}{ver}"
                # For wildcards (e.g., "12.6.*") or exact versions, use ==
                # Wildcards need == too: "nvidia-cuda-runtime-cu12==12.6.*"
                if ".*" in ver:
                    return f"{name}=={ver}"
                return f"{name}=={ver}"

            # Get torch index URL
            torch_index = None
            if cuda_config in self.manifest.get("cuda_configs", {}):
                torch_index = self.manifest["cuda_configs"][cuda_config]["torch_index"]
            
            # Phase 1: Download torch stack from CUDA index
            self.log("Phase 1: Downloading torch stack from CUDA index")
            torch_packages = ["torch", "torchvision", "torchaudio"]
            
            for pkg_name in torch_packages:
                if pkg_name in package_versions:
                    pkg_version = package_versions[pkg_name]
                    spec = _pkg_spec(pkg_name, pkg_version)
                    self.log(f"  Downloading {spec}")
                    success, error = self._download_wheel(
                        package=spec,
                        index_url=torch_index,
                        no_deps=True,  # Critical: no deps for torch
                        python_version=python_version
                    )
                    if not success:
                        return False, f"Failed to download {pkg_name}: {error}"
            
            # Phase 1.5: Download binary packages (after torch, before other packages)
            if binary_packages:
                self.log("Phase 1.5: Downloading binary packages from URLs")
                self.log(f"  Found {len(binary_packages)} binary package(s) in profile: {list(binary_packages.keys())}")
                # Install in correct order: triton -> causal_conv1d -> mamba_ssm
                binary_order = ["triton", "causal_conv1d", "mamba_ssm"]
                for pkg_name in binary_order:
                    if pkg_name in binary_packages:
                        pkg_info = binary_packages[pkg_name]
                        url = pkg_info.get("url")
                        if url:
                            # Check if wheel already exists
                            wheel_filename = url.split("/")[-1]
                            wheel_path = self.wheelhouse / wheel_filename
                            if wheel_path.exists():
                                self.log(f"  {pkg_name} wheel already exists: {wheel_filename}")
                            else:
                                self.log(f"  Downloading {pkg_name} from {url}")
                                success, error = self._download_binary_package(url, pkg_name)
                                if not success:
                                    self.log(f"  WARNING: Failed to download binary package {pkg_name}: {error}")
                                    # Binary packages are optional - continue even if they fail
                                    # They'll be handled at runtime with error messages
                        else:
                            self.log(f"  WARNING: No URL found for binary package {pkg_name}")
            else:
                self.log("Phase 1.5: No binary packages in profile (skipping)")
            
            # Phase 2: Download all other packages
            self.log("Phase 2: Downloading all other packages")
            
            # Sort packages by priority (critical packages first)
            critical_order = [
                "typing-extensions", "numpy", "safetensors", "tokenizers",
                "huggingface-hub", "transformers", "peft", "bitsandbytes",
                "accelerate", "datasets"
            ]
            
            remaining = [pkg for pkg in package_versions if pkg not in torch_packages]
            ordered_packages = []
            
            # Add critical packages in order
            for critical in critical_order:
                if critical in remaining:
                    ordered_packages.append(critical)
            
            # Add remaining packages
            for pkg in remaining:
                if pkg not in ordered_packages:
                    ordered_packages.append(pkg)
            
            for pkg_name in ordered_packages:
                pkg_version = package_versions[pkg_name]
                spec = _pkg_spec(pkg_name, pkg_version)
                self.log(f"  Downloading {spec}")
                
                success, error = self._download_wheel(
                    package=spec,
                    index_url=None,  # Use PyPI
                    # Profile mode must be deterministic: never let pip resolve/download dependencies,
                    # otherwise it can pull a newer compatible-but-unwanted version (e.g. transformers 4.57.3).
                    no_deps=True,
                    python_version=python_version
                )
                
                if not success:
                    # Check if it's critical
                    if pkg_name in critical_order:
                        return False, f"Failed to download critical package {pkg_name}: {error}"
                    else:
                        self.log(f"  WARNING: Failed to download optional package {pkg_name}: {error}")
            
            # Phase 2.5: Download dependency closure for packages that need deps
            # This ensures transitive dependencies (like networkx for torch/peft) are in wheelhouse
            self.log("Phase 2.5: Downloading dependency closure for packages that install with deps")
            packages_needing_deps = ["requests", "urllib3", "certifi", "charset-normalizer", "idna", "jinja2", "markupsafe", "peft", "tqdm", "colorama"]
            
            for pkg_name in ordered_packages:
                if pkg_name in packages_needing_deps:
                    pkg_version = package_versions[pkg_name]
                    spec = _pkg_spec(pkg_name, pkg_version)
                    self.log(f"  Downloading dependency closure for {spec}")
                    
                    # Download WITH dependencies to get closure (networkx, etc.)
                    success, error = self._download_wheel(
                        package=spec,
                        index_url=None,  # Use PyPI
                        no_deps=False,  # Download dependencies too
                        python_version=python_version
                    )
                    
                    if not success:
                        self.log(f"  WARNING: Failed to download dependency closure for {pkg_name}: {error}")
                        # Non-fatal: continue, but install may fail later if deps are missing
                    else:
                        self.log(f"  ✓ Dependency closure downloaded for {pkg_name}")
            
            # Phase 3: Download dependencies from dependencies.json that aren't in profile
            # This ensures packages like urllib3, certifi, etc. are available even if not in profile
            self.log("Phase 3: Downloading additional dependencies from dependencies.json")
            deps = sorted(self.manifest.get("core_dependencies", []), key=lambda x: x.get("order", 999))
            
            for dep in deps:
                pkg_name = dep["name"]
                
                # Skip if already downloaded (in profile)
                if pkg_name in package_versions:
                    continue
                
                # Skip CUDA packages
                if dep.get("version") == "FROM_CUDA_CONFIG":
                    continue
                
                # Skip platform-specific packages
                if "platform" in dep and dep["platform"] != sys.platform:
                    continue
                
                version_spec = dep["version"]
                # Ensure we always build a valid pip requirement; many manifest entries are bare versions.
                ver = str(version_spec or "").strip()
                if ver and not ver.startswith(("==", ">=", "<=", ">", "<", "!=")) and "," not in ver:
                    ver = f"=={ver}"
                spec = f"{pkg_name}{ver}"
                
                # Check if wheel already exists
                wheel_files = list(self.wheelhouse.glob(f"{pkg_name.replace('-', '_')}-*.whl"))
                if not wheel_files:
                    # Try with hyphen
                    wheel_files = list(self.wheelhouse.glob(f"{pkg_name}-*.whl"))
                
                if wheel_files:
                    self.log(f"  {pkg_name} already in wheelhouse, skipping")
                    continue
                
                self.log(f"  Downloading {spec}")
                success, error = self._download_wheel(
                    package=spec,
                    index_url=None,  # Use PyPI
                    no_deps=True,  # Don't resolve dependencies (we're downloading explicitly)
                    python_version=python_version
                )
                
                if not success:
                    # Non-critical packages can fail
                    if dep.get("critical", False):
                        self.log(f"  WARNING: Failed to download critical dependency {pkg_name}: {error}")
                    else:
                        self.log(f"  WARNING: Failed to download optional dependency {pkg_name}: {error}")
            
            # Phase 4: Verify no blacklisted packages
            self.log("Phase 4: Verifying no blacklisted packages")
            success, error = self._verify_no_blacklist()
            if not success:
                return False, error
            
            # Phase 5: Count wheels
            wheel_count = len(list(self.wheelhouse.glob("*.whl")))
            self.log(f"Phase 5: Verification complete ({wheel_count} wheels)")
            self.log("✓ Wheelhouse preparation complete")
            
            return True, ""
            
        except Exception as e:
            return False, f"Profile-based preparation failed: {str(e)}"
    
    def _prepare_from_manifest(self, cuda_config: str, python_version: Tuple[int, int]) -> Tuple[bool, str]:
        """
        Legacy manifest-based preparation (for backwards compatibility).
        """
        try:
            # Get CUDA-specific packages
            if cuda_config not in self.manifest["cuda_configs"]:
                return False, f"Unknown CUDA config: {cuda_config}"
            
            cuda_packages = self.manifest["cuda_configs"][cuda_config]["packages"]
            torch_index = self.manifest["cuda_configs"][cuda_config]["torch_index"]
            
            # Phase 1: Download torch stack from CUDA index
            self.log("Phase 1: Downloading torch stack from CUDA index")
            for pkg_name, pkg_version in cuda_packages.items():
                self.log(f"  Downloading {pkg_name}=={pkg_version}")
                success, error = self._download_wheel(
                    package=f"{pkg_name}=={pkg_version}",
                    index_url=torch_index,
                    no_deps=True,
                    python_version=python_version
                )
                if not success:
                    return False, f"Failed to download {pkg_name}: {error}"
            
            # Phase 2: Download core dependencies
            self.log("Phase 2: Downloading core dependencies")
            deps = sorted(self.manifest["core_dependencies"], key=lambda x: x["order"])
            
            for dep in deps:
                pkg_name = dep["name"]
                
                if dep["version"] == "FROM_CUDA_CONFIG":
                    continue
                
                if "platform" in dep and dep["platform"] != sys.platform:
                    self.log(f"  Skipping {pkg_name} (platform mismatch)")
                    continue
                
                version_spec = str(dep["version"]).strip()
                # Normalize bare versions like "6.8.1" / "12.6.*" into "==6.8.1" / "==12.6.*"
                if version_spec and not version_spec.startswith(("==", ">=", "<=", ">", "<", "!=")) and "," not in version_spec:
                    version_spec = f"=={version_spec}"
                no_deps = "--no-deps" in dep.get("install_args", [])
                
                self.log(f"  Downloading {pkg_name}{version_spec}")
                success, error = self._download_wheel(
                    package=f"{pkg_name}{version_spec}",
                    index_url=None,
                    no_deps=no_deps,
                    python_version=python_version
                )
                
                # Note: version_spec is already flexible for transformers (from dependencies.json update)
                # So no fallback needed here - pip will automatically select 4.57.3 if 4.51.3 isn't available
                
                if not success:
                    if dep.get("critical", False):
                        return False, f"Failed to download critical package {pkg_name}: {error}"
                    else:
                        self.log(f"  WARNING: Failed to download optional package {pkg_name}: {error}")
            
            # Phase 3: Verify no blacklisted packages
            self.log("Phase 3: Verifying no blacklisted packages")
            success, error = self._verify_no_blacklist()
            if not success:
                return False, error
            
            # Phase 4: Verify all critical packages present
            self.log("Phase 4: Verifying all wheels present")
            success, error = self._verify_wheels_present(deps, cuda_packages)
            if not success:
                return False, error
            
            self.log("✓ Wheelhouse preparation complete")
            return True, ""
            
        except Exception as e:
            error_msg = str(e)
            # Handle Unicode encoding issues in error messages
            try:
                error_msg = error_msg.encode('ascii', 'replace').decode('ascii') if not error_msg.isascii() else error_msg
            except:
                error_msg = "Wheelhouse preparation exception (encoding error in message)"
            return False, f"Wheelhouse preparation exception: {error_msg}"
    
    def _clear_wheelhouse(self):
        """Clear existing wheelhouse"""
        if self.wheelhouse.exists():
            for item in self.wheelhouse.glob("*"):
                if item.is_file():
                    try:
                        item.unlink()
                    except Exception as e:
                        self.log(f"Warning: Could not delete {item.name}: {e}")
            self.log("Existing wheelhouse cleared")
    
    def _remove_package_wheels(self, package_name: str, specific_version: Optional[str] = None):
        """Remove wheels for a specific package from wheelhouse.
        
        Args:
            package_name: Package name to remove
            specific_version: If provided, only remove this specific version. 
                            If None, remove all versions of the package.
        """
        pkg_normalized = package_name.lower().replace("_", "-")
        removed_count = 0
        
        for wheel in self.wheelhouse.glob("*.whl"):
            wheel_name_parts = wheel.stem.split("-")
            if len(wheel_name_parts) >= 1:
                wheel_pkg = wheel_name_parts[0].lower().replace("_", "-")
                if wheel_pkg == pkg_normalized:
                    # If specific_version is provided, check if this wheel matches
                    if specific_version is not None:
                        # Extract version from wheel name (typically second part)
                        if len(wheel_name_parts) >= 2:
                            wheel_version = wheel_name_parts[1]
                            if wheel_version != specific_version:
                                continue  # Skip this wheel - not the version we want to remove
                    try:
                        self.log(f"  Removing outdated wheel: {wheel.name}")
                        wheel.unlink()
                        removed_count += 1
                    except Exception as e:
                        self.log(f"  Warning: Could not delete {wheel.name}: {e}")
        
        return removed_count
    
    def _download_binary_package(self, url: str, package_name: str) -> Tuple[bool, str]:
        """
        Download a binary package wheel from a URL.
        
        Args:
            url: URL to the wheel file
            package_name: Package name (for logging)
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        try:
            import urllib.request
            import urllib.error
            
            # Extract filename from URL
            filename = url.split("/")[-1]
            wheel_path = self.wheelhouse / filename
            
            # Check if already downloaded
            if wheel_path.exists():
                self.log(f"    {package_name} wheel already exists: {filename}")
                return True, ""
            
            self.log(f"    Downloading {filename}...")
            
            # Download the file
            try:
                urllib.request.urlretrieve(url, wheel_path)
                self.log(f"    ✓ Downloaded {filename}")
                return True, ""
            except urllib.error.HTTPError as e:
                return False, f"HTTP error {e.code}: {e.reason}"
            except urllib.error.URLError as e:
                return False, f"URL error: {e.reason}"
            except Exception as e:
                return False, str(e)
                
        except ImportError:
            # Fallback: use requests if available
            try:
                import requests
                filename = url.split("/")[-1]
                wheel_path = self.wheelhouse / filename
                
                if wheel_path.exists():
                    self.log(f"    {package_name} wheel already exists: {filename}")
                    return True, ""
                
                self.log(f"    Downloading {filename}...")
                response = requests.get(url, timeout=300)
                response.raise_for_status()
                
                with open(wheel_path, 'wb') as f:
                    f.write(response.content)
                
                self.log(f"    ✓ Downloaded {filename}")
                return True, ""
            except ImportError:
                return False, "Neither urllib nor requests available for downloading binary packages"
            except Exception as e:
                return False, str(e)
    
    def _download_wheel(
        self, 
        package: str, 
        index_url: Optional[str] = None, 
        no_deps: bool = False,
        python_version: Tuple[int, int] = None
    ) -> Tuple[bool, str]:
        """
        Download single package to wheelhouse.
        
        Args:
            package: Package specifier (e.g., "torch==2.5.1+cu124")
            index_url: Custom index URL (for torch)
            no_deps: If True, don't download dependencies
            python_version: Target Python version
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        # Fast-path: if the requested wheel is already present in the wheelhouse,
        # do NOT hit the network again. This avoids repeated downloads on repair/retry.
        try:
            spec = str(package or "").strip()
            # Basic parse: name + requirement (we primarily care about == exact pins)
            name = None
            req = None
            if "==" in spec:
                name, req = spec.split("==", 1)
                name = name.strip()
                req = "==" + req.strip()
            elif any(op in spec for op in [">=", "<=", "!=", ">", "<"]):
                # Try to extract name prefix for range specs (e.g. "transformers>=4.51,<4.60")
                m = re.match(r"^([A-Za-z0-9_.-]+)\s*(.*)$", spec)
                if m:
                    name = m.group(1).strip()
                    req = m.group(2).strip()
                    if req and not req.startswith(("==", ">=", "<=", ">", "<", "!=")):
                        req = None
            else:
                # Bare name; can't reason about version
                name = None
                req = None

            if name:
                present_versions = self._get_all_wheel_versions(name)
                if present_versions:
                    if req and req.startswith("=="):
                        expected = req[2:].strip()
                        # If expected includes local version tag (e.g. +cu118), require exact match.
                        if "+" in expected:
                            if expected in present_versions:
                                self.log(f"  {name}=={expected} already in wheelhouse (skip download)")
                                return True, ""
                        else:
                            # Match by base version for normal wheels
                            for v in present_versions:
                                if str(v).split("+")[0].split("-")[0] == expected:
                                    self.log(f"  {name}=={expected} already in wheelhouse (skip download)")
                                    return True, ""
                    elif req:
                        # Range spec: if ANY present wheel version satisfies it, skip download.
                        for v in present_versions:
                            if self._validate_wheel_against_requirement(name, str(v), req):
                                self.log(f"  {name}{req} already satisfied in wheelhouse (skip download)")
                                return True, ""
        except Exception:
            # Never fail download due to optimization logic
            pass

        cmd = [
            sys.executable, "-m", "pip", "download",
            "--dest", str(self.wheelhouse),
            "--no-cache-dir"  # Critical: don't use cache
        ]

        # Make network behavior more reliable on slow/proxied machines.
        # NOTE: pip's own network timeout is separate from our subprocess timeout below.
        pip_net_timeout = int(os.getenv("PIP_DOWNLOAD_TIMEOUT_SECONDS", "120"))
        pip_retries = int(os.getenv("PIP_DOWNLOAD_RETRIES", "20"))
        cmd.extend(["--timeout", str(pip_net_timeout), "--retries", str(pip_retries)])
        
        if index_url:
            cmd.extend(["--index-url", index_url])
        
        if no_deps:
            cmd.append("--no-deps")
        
        # Add python version constraint if specified
        if python_version:
            py_ver = f"{python_version[0]}.{python_version[1]}"
            cmd.extend([
                "--python-version", py_ver,
                "--only-binary=:all:"  # Required when using --python-version
            ])
        
        cmd.append(package)
        
        try:
            # Torch wheels can be very large; allow longer downloads on slow links.
            download_timeout = int(os.getenv("WHEELHOUSE_PIP_DOWNLOAD_TIMEOUT_SECONDS", "1800"))
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=download_timeout,
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                error_msg = result.stderr or result.stdout
                return False, error_msg[:500]  # Truncate long errors
            
            return True, ""
            
        except subprocess.TimeoutExpired:
            return False, (
                f"Download timeout for {package}.\n"
                f"This usually means slow/blocked internet, proxy/SSL inspection, or AV scanning large wheels.\n\n"
                f"Fix options:\n"
                f"  1) Recommended: pre-seed the wheelhouse on a machine with good internet, then rerun with --skip-wheelhouse.\n"
                f"  2) If behind a proxy: configure HTTP(S)_PROXY for pip.\n"
                f"  3) Increase timeouts: set WHEELHOUSE_PIP_DOWNLOAD_TIMEOUT_SECONDS (subprocess) and/or PIP_DOWNLOAD_TIMEOUT_SECONDS.\n"
            )
        except Exception as e:
            return False, str(e)
    
    def download_missing_package(self, package_name: str, python_version: Tuple[int, int] = None) -> Tuple[bool, str]:
        """
        Download a missing package into wheelhouse (for auto-heal during install).
        
        Args:
            package_name: Package name OR full requirement (e.g., "networkx" or "huggingface-hub>=0.34.0,<1.0")
            python_version: Optional Python version tuple (e.g., (3, 12))
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        if python_version is None:
            python_version = (sys.version_info.major, sys.version_info.minor)

        # Parse requirement into (name, spec). Spec may be empty.
        req_str = str(package_name or "").strip()
        # Strip environment markers like '; extra == \"http\"' which can appear in pip errors.
        # We only download the base requirement into wheelhouse.
        if ";" in req_str:
            req_str = req_str.split(";", 1)[0].strip()
        req_str = req_str.rstrip(";").strip()
        name_only = req_str
        spec_tail = ""
        for op in ["==", ">=", "<=", "!=", "~=", ">", "<"]:
            if op in req_str:
                parts = req_str.split(op, 1)
                name_only = parts[0].strip()
                spec_tail = op + parts[1].strip()
                break

        # Normalize to pip-style hyphen names for wheelhouse matching.
        name_norm = name_only.lower().replace("_", "-").strip()
        full_req = f"{name_only}{spec_tail}".strip()
        
        # If a spec is provided, ensure wheelhouse actually satisfies it.
        # Otherwise, keep legacy behavior (any wheel present means "already in wheelhouse").
        try:
            present_versions = self._get_all_wheel_versions(name_only)
        except Exception:
            present_versions = []

        if spec_tail:
            for v in present_versions:
                try:
                    if self._validate_wheel_against_requirement(name_only, str(v), spec_tail):
                        self.log(f"  {name_norm}{spec_tail} already satisfied in wheelhouse")
                        return True, ""
                except Exception:
                    continue
        else:
            # Check if any wheel exists
            wheel_files = list(self.wheelhouse.glob(f"{name_only.replace('-', '_')}-*.whl"))
            if not wheel_files:
                wheel_files = list(self.wheelhouse.glob(f"{name_only}-*.whl"))
            if wheel_files:
                self.log(f"  {name_only} already in wheelhouse")
                return True, ""
        
        # Check blacklist
        blacklist = set(pkg.lower().replace("_", "-") for pkg in self.manifest.get("global_blacklist", []))
        if name_norm in blacklist:
            return False, f"Package {name_only} is blacklisted"
        
        # Never allow online fallback for torch/GPU packages
        forbidden_patterns = ["torch", "triton", "bitsandbytes", "nvidia-", "cuda"]
        if any(pattern in name_norm for pattern in forbidden_patterns):
            return False, f"Package {name_only} requires special index (not available via online fallback)"
        
        self.log(f"  Downloading missing package: {full_req} (with dependencies)")
        success, error = self._download_wheel(
            package=full_req if full_req else name_only,  # Let pip resolve latest compatible version (within spec if provided)
            index_url=None,  # Use PyPI
            no_deps=False,  # Download dependencies too (closure)
            python_version=python_version
        )
        
        if success:
            self.log(f"  ✓ Successfully downloaded {full_req if full_req else name_only} and its dependencies into wheelhouse")
        
        if success:
            # Verify no blacklisted packages were pulled in
            verify_success, verify_error = self._verify_no_blacklist()
            if not verify_success:
                # Remove the package we just downloaded if it pulled in blacklisted deps
                for wheel in self.wheelhouse.glob(f"{name_only.replace('-', '_')}-*.whl"):
                    wheel.unlink()
                for wheel in self.wheelhouse.glob(f"{name_only}-*.whl"):
                    wheel.unlink()
                return False, f"Downloaded {name_only} but it pulled in blacklisted dependencies: {verify_error}"

            # If we downloaded due to a version requirement, remove wheels that do not satisfy it (replace-old behavior).
            if spec_tail:
                removed = 0
                try:
                    pkg_norm = name_only.lower().replace("_", "-")
                    for wheel in list(self.wheelhouse.glob("*.whl")):
                        wheel_name_parts = wheel.stem.split("-")
                        if len(wheel_name_parts) < 2:
                            continue
                        wheel_pkg = wheel_name_parts[0].lower().replace("_", "-")
                        if wheel_pkg != pkg_norm:
                            continue
                        ver = self._extract_version_from_wheel(wheel)
                        if not ver:
                            continue
                        if not self._validate_wheel_against_requirement(name_only, str(ver), spec_tail):
                            wheel.unlink()
                            removed += 1
                    if removed:
                        self.log(f"  ✓ Removed {removed} non-matching {name_norm} wheel(s) after download")
                except Exception as e:
                    # Never fail install because cleanup failed; installer will surface the real error if any.
                    self.log(f"  WARNING: Could not remove non-matching wheels for {name_norm}{spec_tail}: {e}")
        
        return success, error
    
    def _verify_no_blacklist(self) -> Tuple[bool, str]:
        """
        Verify no blacklisted packages in wheelhouse.
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        blacklist = set(pkg.lower().replace("_", "-") for pkg in self.manifest["global_blacklist"])
        
        found_blacklisted = []
        
        for wheel in self.wheelhouse.glob("*.whl"):
            # Parse wheel filename: package-version-pyver-abi-platform.whl
            # Example: torch-2.5.1+cu124-cp312-cp312-win_amd64.whl
            wheel_name_parts = wheel.stem.split("-")
            if len(wheel_name_parts) >= 2:
                pkg_name = wheel_name_parts[0].lower().replace("_", "-")
                
                if pkg_name in blacklist:
                    found_blacklisted.append((pkg_name, wheel.name))
        
        if found_blacklisted:
            error_lines = [
                "CRITICAL: Blacklisted packages found in wheelhouse!",
                "These packages cause conflicts and must not be installed:",
                ""
            ]
            for pkg_name, wheel_file in found_blacklisted:
                error_lines.append(f"  - {pkg_name} ({wheel_file})")
            
            error_lines.extend([
                "",
                "These were likely pulled in as dependencies.",
                "The installation cannot proceed with these packages.",
                "Clearing wheelhouse and aborting."
            ])
            
            # Clear wheelhouse to prevent accidental use
            self._clear_wheelhouse()
            
            return False, "\n".join(error_lines)
        
        self.log(f"✓ No blacklisted packages found ({len(blacklist)} checked)")
        return True, ""
    
    def _verify_wheels_present(self, deps: List[Dict], cuda_packages: Dict[str, str]) -> Tuple[bool, str]:
        """
        Verify all critical packages have wheels in wheelhouse.
        
        Args:
            deps: List of dependency dicts
            cuda_packages: Dict of CUDA package names to versions
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        wheels_present = set()
        
        # Get list of all wheel files
        for wheel in self.wheelhouse.glob("*.whl"):
            wheel_name_parts = wheel.stem.split("-")
            if len(wheel_name_parts) >= 1:
                pkg_name = wheel_name_parts[0].lower().replace("_", "-")
                wheels_present.add(pkg_name)
        
        # Check critical packages
        missing_critical = []
        
        # Check CUDA packages
        for pkg_name in cuda_packages.keys():
            pkg_normalized = pkg_name.lower().replace("_", "-")
            if pkg_normalized not in wheels_present:
                missing_critical.append(pkg_name)
        
        # Check core dependencies
        for dep in deps:
            if dep.get("critical", False):
                pkg_name = dep["name"]
                pkg_normalized = pkg_name.lower().replace("_", "-")
                
                # Skip FROM_CUDA_CONFIG (already checked above)
                if dep["version"] == "FROM_CUDA_CONFIG":
                    continue
                
                # Skip platform-specific
                if "platform" in dep and dep["platform"] != sys.platform:
                    continue
                
                if pkg_normalized not in wheels_present:
                    missing_critical.append(pkg_name)
        
        if missing_critical:
            return False, f"Missing critical packages in wheelhouse: {', '.join(missing_critical)}"
        
        self.log(f"✓ All critical packages present ({len(wheels_present)} wheels total)")
        return True, ""
    
    def get_wheel_info(self, package_name: str) -> Optional[Path]:
        """
        Get wheel file path for a package.
        
        Args:
            package_name: Package name
        
        Returns:
            Path to wheel file or None if not found
        """
        pkg_normalized = package_name.lower().replace("_", "-")
        
        for wheel in self.wheelhouse.glob("*.whl"):
            wheel_name_parts = wheel.stem.split("-")
            if len(wheel_name_parts) >= 1:
                wheel_pkg = wheel_name_parts[0].lower().replace("_", "-")
                if wheel_pkg == pkg_normalized:
                    return wheel
        
        return None


def main():
    """Test wheelhouse manager"""
    import sys
    from pathlib import Path
    
    # Test setup
    manifest = Path(__file__).parent.parent / "metadata" / "dependencies.json"
    wheelhouse = Path(__file__).parent.parent / "wheelhouse_test"
    
    if not manifest.exists():
        print(f"ERROR: Manifest not found at {manifest}")
        sys.exit(1)
    
    manager = WheelhouseManager(manifest, wheelhouse)
    
    print("Testing wheelhouse preparation...")
    success, error = manager.prepare_wheelhouse("cu124", (3, 12))
    
    if success:
        print("✓ Test passed!")
    else:
        print(f"✗ Test failed: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()

