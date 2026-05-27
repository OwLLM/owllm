#!/usr/bin/env python3
"""
Diagnose Installation Issues
Checks what's actually installed vs what's expected
"""

import sys
import subprocess
from pathlib import Path
import json

def check_installed_packages(venv_python):
    """Get all installed packages from pip list"""
    print("\n" + "="*60)
    print("INSTALLED PACKAGES (via pip list)")
    print("="*60)
    
    result = subprocess.run(
        [str(venv_python), "-m", "pip", "list", "--format=json"],
        capture_output=True,
        text=True
    )
    
    if result.returncode == 0:
        packages = json.loads(result.stdout)
        for pkg in sorted(packages, key=lambda x: x['name']):
            print(f"  {pkg['name']:30s} {pkg['version']}")
        return packages
    else:
        print(f"ERROR: Failed to get pip list: {result.stderr}")
        return []

def check_importable(venv_python, import_name):
    """Check if a module can be imported"""
    code = f"import {import_name}; print('OK')"
    result = subprocess.run(
        [str(venv_python), "-c", code],
        capture_output=True,
        text=True,
        timeout=10
    )
    return result.returncode == 0, result.stderr

def check_metadata_version(venv_python, package_name):
    """Check version using importlib.metadata"""
    code = f"""
from importlib.metadata import version, PackageNotFoundError
try:
    print(version('{package_name}'))
except PackageNotFoundError:
    print('NOT_FOUND')
"""
    result = subprocess.run(
        [str(venv_python), "-c", code],
        capture_output=True,
        text=True,
        timeout=10
    )
    return result.stdout.strip() if result.returncode == 0 else "ERROR"

def diagnose_key_packages(venv_python):
    """Diagnose key packages that commonly fail verification"""
    print("\n" + "="*60)
    print("KEY PACKAGE DIAGNOSTICS")
    print("="*60)
    
    # List of key packages with their pip names and import names
    key_packages = [
        ("torch", "torch"),
        ("transformers", "transformers"),
        ("tokenizers", "tokenizers"),
        ("huggingface-hub", "huggingface_hub"),
        ("safetensors", "safetensors"),
        ("peft", "peft"),
        ("accelerate", "accelerate"),
        ("bitsandbytes", "bitsandbytes"),
        ("datasets", "datasets"),
        ("triton-windows", "triton"),
        ("mamba-ssm", "mamba_ssm"),
        ("PySide6", "PySide6"),
        ("numpy", "numpy"),
    ]
    
    for pip_name, import_name in key_packages:
        print(f"\n{pip_name}:")
        
        # Check via importlib.metadata
        metadata_version = check_metadata_version(venv_python, pip_name)
        print(f"  metadata.version('{pip_name}'): {metadata_version}")
        
        # If pip name didn't work, try import name
        if metadata_version in ("NOT_FOUND", "ERROR") and pip_name != import_name:
            metadata_version_import = check_metadata_version(venv_python, import_name)
            print(f"  metadata.version('{import_name}'): {metadata_version_import}")
        
        # Check if importable
        can_import, error = check_importable(venv_python, import_name)
        if can_import:
            print(f"  import {import_name}: ✓ OK")
        else:
            print(f"  import {import_name}: ✗ FAILED")
            if error:
                print(f"    Error: {error[:200]}")

def check_venv_health(venv_path):
    """Check if venv is healthy"""
    print("\n" + "="*60)
    print("VIRTUAL ENVIRONMENT HEALTH")
    print("="*60)
    
    venv_python = venv_path / "Scripts" / "python.exe"
    
    if not venv_python.exists():
        print(f"✗ Python executable not found: {venv_python}")
        return False
    
    print(f"✓ Python executable: {venv_python}")
    
    # Check Python version
    result = subprocess.run(
        [str(venv_python), "--version"],
        capture_output=True,
        text=True
    )
    print(f"  Version: {result.stdout.strip()}")
    
    # Check site-packages
    site_packages = venv_path / "Lib" / "site-packages"
    if site_packages.exists():
        num_packages = len(list(site_packages.glob("*.dist-info")))
        print(f"✓ Site-packages: {site_packages}")
        print(f"  Packages installed: {num_packages}")
    else:
        print(f"✗ Site-packages not found: {site_packages}")
    
    return True

def main():
    """Run full diagnostic"""
    print("="*60)
    print("LLM STUDIO - INSTALLATION DIAGNOSTICS")
    print("="*60)
    
    # Find venv (prefer env_key environment if present)
    script_dir = Path(__file__).parent
    venv_path = script_dir / ".venv"
    try:
        # Prefer active env_key based on state file location
        state_file = script_dir / ".install_state.json"
        if state_file.exists():
            with open(state_file, "r", encoding="utf-8") as f:
                st = json.load(f)
            if st.get("venv_path"):
                venv_path = Path(st["venv_path"])
    except Exception:
        pass
    
    if not venv_path.exists():
        print(f"\n✗ Virtual environment not found: {venv_path}")
        print("Please run the installer first!")
        sys.exit(1)
    
    # Check venv health
    if not check_venv_health(venv_path):
        print("\n✗ Virtual environment is not healthy!")
        sys.exit(1)
    
    venv_python = venv_path / "Scripts" / "python.exe"
    
    # Get all installed packages
    packages = check_installed_packages(venv_python)
    
    # Diagnose key packages
    diagnose_key_packages(venv_python)
    
    # Check state files
    print("\n" + "="*60)
    print("STATE FILES")
    print("="*60)
    
    # State/marker live alongside the active venv
    base_dir = venv_path.parent
    state_file = base_dir / ".install_state.json"
    setup_marker = base_dir / ".setup_complete"
    
    if state_file.exists():
        print(f"✓ State file exists: {state_file}")
        try:
            with open(state_file) as f:
                state = json.load(f)
            print(f"  install_complete: {state.get('install_complete')}")
            print(f"  verification_passed: {state.get('verification_passed')}")
            print(f"  cuda_config: {state.get('cuda_config')}")
            print(f"  timestamp: {state.get('install_timestamp')}")
        except Exception as e:
            print(f"  Error reading state: {e}")
    else:
        print(f"✗ State file not found: {state_file}")
    
    if setup_marker.exists():
        print(f"✓ Setup marker exists: {setup_marker}")
    else:
        print(f"✗ Setup marker not found: {setup_marker}")
    
    print("\n" + "="*60)
    print("DIAGNOSTIC COMPLETE")
    print("="*60)

if __name__ == "__main__":
    main()
