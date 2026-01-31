#!/usr/bin/env python3
"""
check_install_state.py - Diagnostic Tool for Installation State
Shows detailed information about the current installation state
"""

import sys
import json
from pathlib import Path
from datetime import datetime

def print_section(title):
    """Print section header"""
    print("\n" + "=" * 60)
    print(title)
    print("=" * 60)

def check_state_file():
    """Check .install_state.json"""
    print_section("Installation State File")
    
    llm_dir = Path(__file__).parent
    state_file = llm_dir / ".install_state.json"
    active_env_key = None

    # Prefer per-env state if env_key environments are in use
    try:
        from system_detector import SystemDetector
        from core.profile_selector import ProfileSelector
        from setup_state import SetupStateManager
        from core.envs.env_key_resolver import encode_torch_mm

        matrix_path = llm_dir / "metadata" / "compatibility_matrix.json"
        setup_state = SetupStateManager()
        selected_gpu_index = setup_state.get_selected_gpu_index()
        override_profile = setup_state.get_selected_profile()

        detector = SystemDetector()
        hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)
        selector = ProfileSelector(matrix_path)
        _profile_name, package_versions, _warnings, _binary = selector.select_profile(
            hw_profile, override_profile_id=override_profile
        )

        torch_spec = str((package_versions or {}).get("torch", "")).strip()
        accelerator = "cpu"
        if "+cu" in torch_spec:
            cuda_part = torch_spec.split("+cu", 1)[1]
            digits = "".join([c for c in cuda_part if c.isdigit()])[:3]
            if digits:
                accelerator = f"cu{digits}"
        torch_mm = ""
        if torch_spec:
            base = torch_spec.split("+", 1)[0]
            parts = base.split(".")
            if len(parts) >= 2:
                torch_mm = f"{parts[0]}.{parts[1]}"
        t_enc = encode_torch_mm(torch_mm) if torch_mm else ""
        active_env_key = f"tf-{accelerator}-t{t_enc}-base-stable" if t_enc else f"tf-{accelerator}-base-stable"

        per_env_state = llm_dir / ".envs" / active_env_key / ".install_state.json"
        if per_env_state.exists():
            state_file = per_env_state
    except Exception:
        pass
    
    if not state_file.exists():
        print("❌ State file NOT FOUND")
        print(f"   Expected location: {state_file}")
        print("   This means no installation has completed successfully")
        return None
    
    if active_env_key and ".envs" in str(state_file):
        print(f"✓ Active env_key: {active_env_key}")
    print(f"✓ State file exists: {state_file}")
    
    try:
        with open(state_file, 'r', encoding='utf-8') as f:
            state = json.load(f)
        
        print("\nState File Contents:")
        print(json.dumps(state, indent=2))
        
        # Analyze state
        print("\nState Analysis:")
        
        if state.get("install_complete"):
            print("  ✓ Installation marked as complete")
        else:
            print("  ❌ Installation NOT complete")
        
        if state.get("verification_passed"):
            print("  ✓ Verification passed")
        else:
            print("  ⚠ Verification did NOT pass")
        
        timestamp = state.get("install_timestamp")
        if timestamp:
            try:
                install_time = datetime.fromisoformat(timestamp)
                now = datetime.now()
                delta = now - install_time
                hours = delta.total_seconds() / 3600
                print(f"  ⏰ Timestamp: {timestamp} ({hours:.1f} hours ago)")
            except:
                print(f"  ⏰ Timestamp: {timestamp} (cannot parse)")
        
        print(f"  🔧 CUDA config: {state.get('cuda_config', 'unknown')}")
        print(f"  🐍 Python version: {state.get('python_version', 'unknown')}")
        
        if state.get("installer_level"):
            print(f"  ℹ️ Created by: {state['installer_level']}")
        
        return state
    except Exception as e:
        print(f"❌ Error reading state file: {e}")
        return None

def check_venv():
    """Check virtual environment"""
    print_section("Virtual Environment")
    
    llm_dir = Path(__file__).parent
    # Prefer env_key venv if available
    venv_dir = llm_dir / ".venv"
    try:
        envs_dir = llm_dir / ".envs"
        if envs_dir.exists():
            # Use state file selection logic to find env_key venv (best-effort)
            state = check_state_file()
            if state and state.get("venv_path"):
                venv_dir = Path(state["venv_path"])
    except Exception:
        pass
    
    if not venv_dir.exists():
        print("❌ .venv directory NOT FOUND")
        print(f"   Expected location: {venv_dir}")
        return False
    
    print(f"✓ .venv exists: {venv_dir}")
    
    if sys.platform == 'win32':
        python_exe = venv_dir / "Scripts" / "python.exe"
    else:
        python_exe = venv_dir / "bin" / "python"
    
    if python_exe.exists():
        print(f"✓ Python executable: {python_exe}")
        
        # Try to get version
        import subprocess
        try:
            result = subprocess.run(
                [str(python_exe), "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                print(f"  Version: {result.stdout.strip()}")
            else:
                print(f"  ⚠ Cannot get version (exit code {result.returncode})")
        except Exception as e:
            print(f"  ⚠ Cannot run Python: {e}")
        
        return True
    else:
        print(f"❌ Python executable NOT FOUND: {python_exe}")
        return False

def check_wheelhouse():
    """Check wheelhouse directory"""
    print_section("Wheelhouse (Downloaded Packages)")
    
    llm_dir = Path(__file__).parent
    wheelhouse_dir = llm_dir / "wheelhouse"
    try:
        state = check_state_file()
        if state and state.get("venv_path"):
            # If using env_key env, wheelhouse is namespaced by env_key folder name
            venv_path = Path(state["venv_path"])
            if ".envs" in str(venv_path):
                env_key = venv_path.parent.name
                wheelhouse_dir = wheelhouse_dir / env_key
    except Exception:
        pass
    
    if not wheelhouse_dir.exists():
        print("❌ wheelhouse directory NOT FOUND")
        print(f"   Expected location: {wheelhouse_dir}")
        return False
    
    print(f"✓ wheelhouse exists: {wheelhouse_dir}")
    
    wheels = list(wheelhouse_dir.glob("*.whl"))
    print(f"  Wheel files: {len(wheels)}")
    
    if wheels:
        print(f"  Total size: {sum(w.stat().st_size for w in wheels) / (1024**3):.2f} GB")
        print("\n  Sample wheels:")
        for wheel in sorted(wheels)[:10]:
            size_mb = wheel.stat().st_size / (1024**2)
            print(f"    - {wheel.name} ({size_mb:.1f} MB)")
        if len(wheels) > 10:
            print(f"    ... and {len(wheels) - 10} more")
    else:
        print("  ⚠ No wheel files found")
    
    return len(wheels) > 0

def check_markers():
    """Check marker files"""
    print_section("Marker Files")
    
    llm_dir = Path(__file__).parent
    
    markers = {
        ".setup_complete": "Setup complete marker (legacy)",
        ".setup_state.json": "Setup state (first_run_setup.py)",
        ".install_state.json": "Install state (immutable_installer.py)",
    }
    
    for marker_name, description in markers.items():
        marker_path = llm_dir / marker_name
        if marker_path.exists():
            size = marker_path.stat().st_size
            mtime = datetime.fromtimestamp(marker_path.stat().st_mtime)
            print(f"✓ {marker_name}")
            print(f"    Description: {description}")
            print(f"    Modified: {mtime}")
            print(f"    Size: {size} bytes")
        else:
            print(f"❌ {marker_name} - NOT FOUND")
            print(f"    Description: {description}")

def check_packages():
    """Check if key packages are installed in venv"""
    print_section("Installed Packages (Sample)")
    
    llm_dir = Path(__file__).parent
    venv_dir = llm_dir / ".venv"
    try:
        state = check_state_file()
        if state and state.get("venv_path"):
            venv_dir = Path(state["venv_path"])
    except Exception:
        pass
    
    if sys.platform == 'win32':
        python_exe = venv_dir / "Scripts" / "python.exe"
    else:
        python_exe = venv_dir / "bin" / "python"
    
    if not python_exe.exists():
        print("❌ Cannot check packages - Python not found")
        return
    
    key_packages = ["torch", "transformers", "PySide6", "numpy", "datasets"]
    
    import subprocess
    for pkg in key_packages:
        try:
            result = subprocess.run(
                [str(python_exe), "-c", f"import {pkg}; print({pkg}.__version__)"],
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                version = result.stdout.strip()
                print(f"  ✓ {pkg}: {version}")
            else:
                print(f"  ❌ {pkg}: NOT INSTALLED or import failed")
        except Exception as e:
            print(f"  ❌ {pkg}: Error checking ({e})")

def main():
    """Main diagnostic function"""
    print("=" * 60)
    print("LLM FINE-TUNING STUDIO - INSTALLATION STATE DIAGNOSTIC")
    print("=" * 60)
    
    llm_dir = Path(__file__).parent
    print(f"\nLLM Directory: {llm_dir}")
    
    # Run all checks
    state = check_state_file()
    venv_ok = check_venv()
    wheelhouse_ok = check_wheelhouse()
    check_markers()
    
    if venv_ok:
        check_packages()
    
    # Summary
    print_section("Summary")
    
    if state and state.get("install_complete") and state.get("verification_passed"):
        print("✅ Installation appears COMPLETE and VERIFIED")
        print("   You should be able to launch the application.")
    elif state and state.get("install_complete"):
        print("⚠️ Installation COMPLETE but verification FAILED")
        print("   Some packages may be missing or broken.")
        print("   Try running repair mode.")
    elif venv_ok and wheelhouse_ok:
        print("⚠️ Installation PARTIAL")
        print("   .venv and wheelhouse exist but no state file.")
        print("   Installation may have been interrupted.")
        print("   Try running the installer again - it should resume.")
    else:
        print("❌ Installation NOT COMPLETE")
        print("   Run the installer to set up the environment.")
    
    print("\nRecommended Actions:")
    if not state:
        print("  1. Run installer (LAUNCHER.bat or START_APP.bat)")
    elif not state.get("verification_passed"):
        print("  1. Try repair mode in installer")
        print("  2. If that fails, try rebuild mode (deletes and reinstalls)")
    else:
        print("  ✓ No action needed - installation looks good!")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nCancelled by user.")
        sys.exit(0)
    except Exception as e:
        print(f"\nDiagnostic error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
