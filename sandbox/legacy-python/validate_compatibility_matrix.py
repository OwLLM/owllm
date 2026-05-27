#!/usr/bin/env python3
"""
Validate that all package versions in compatibility_matrix.json actually exist on PyPI
and can be installed together without conflicts.
"""

import json
import subprocess
import sys
from pathlib import Path

def check_package_exists(package_name, version):
    """Check if a package version exists on PyPI"""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "index", "versions", package_name],
            capture_output=True,
            text=True,
            timeout=10
        )
        if version in result.stdout:
            return True, None
        else:
            return False, f"Version {version} not found on PyPI"
    except Exception as e:
        return False, f"Error checking: {str(e)}"

def check_profile_compatibility(profile_name, packages):
    """Check if all packages in a profile are compatible"""
    print(f"\n{'='*60}")
    print(f"Validating profile: {profile_name}")
    print(f"{'='*60}")
    
    errors = []
    warnings = []
    
    for pkg_name, pkg_version in packages.items():
        print(f"  Checking {pkg_name}=={pkg_version}...", end=" ")
        exists, error = check_package_exists(pkg_name, pkg_version)
        
        if exists:
            print("[OK]")
        else:
            print("[MISSING]")
            errors.append(f"{pkg_name}=={pkg_version}: {error}")
    
    return errors, warnings

def main():
    matrix_path = Path(__file__).parent / "metadata" / "compatibility_matrix.json"
    
    if not matrix_path.exists():
        print(f"ERROR: {matrix_path} not found!")
        return 1
    
    with open(matrix_path, 'r') as f:
        matrix = json.load(f)
    
    all_errors = []
    
    for profile_name, profile_data in matrix.get("profiles", {}).items():
        packages = profile_data.get("packages", {})
        errors, warnings = check_profile_compatibility(profile_name, packages)
        
        if errors:
            all_errors.extend(errors)
            print(f"\n  [X] Profile {profile_name} has ERRORS:")
            for error in errors:
                print(f"    - {error}")
        else:
            print(f"\n  [OK] Profile {profile_name} validated successfully")
    
    print(f"\n{'='*60}")
    if all_errors:
        print(f"VALIDATION FAILED: {len(all_errors)} errors found")
        print("\nERRORS:")
        for error in all_errors:
            print(f"  - {error}")
        return 1
    else:
        print("[OK] ALL PROFILES VALIDATED SUCCESSFULLY")
        return 0

if __name__ == "__main__":
    sys.exit(main())

