#!/usr/bin/env python3
"""
Quick script to check if binary packages (causal_conv1d, mamba_ssm, triton) are installed.
Run this to verify installation status.
"""

import sys
from pathlib import Path

def check_package(pkg_name, import_name=None):
    """Check if a package is installed and return version if available."""
    if import_name is None:
        import_name = pkg_name
    
    try:
        module = __import__(import_name)
        version = getattr(module, '__version__', 'unknown')
        return True, version
    except ImportError:
        return False, None
    except Exception as e:
        return False, f"Error: {e}"

def main():
    print("=" * 60)
    print("Binary Package Installation Check")
    print("=" * 60)
    print()
    
    packages_to_check = [
        ("triton", "triton"),
        ("causal_conv1d", "causal_conv1d"),
        ("mamba_ssm", "mamba_ssm"),
    ]
    
    all_ok = True
    for pkg_name, import_name in packages_to_check:
        is_installed, version = check_package(pkg_name, import_name)
        if is_installed:
            print(f"✓ {pkg_name}: Installed (version: {version})")
        else:
            print(f"✗ {pkg_name}: NOT INSTALLED")
            if version:
                print(f"  {version}")
            all_ok = False
    
    print()
    print("=" * 60)
    if all_ok:
        print("✓ All binary packages are installed")
    else:
        print("⚠ Some binary packages are missing")
        print()
        print("To install them, run the installer which will:")
        print("  1. Download Windows wheels from GitHub")
        print("  2. Install them in the correct order (triton -> causal_conv1d -> mamba_ssm)")
        print("  3. Make them available for Mamba/SSM models")
    print("=" * 60)
    
    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())
