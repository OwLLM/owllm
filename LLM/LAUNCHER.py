#!/usr/bin/env python3
"""
LAUNCHER.py - Python Launcher for LLM Fine-tuning Studio
Pure Python equivalent of Launcher.exe that works on ANY computer with Python
"""

import sys
import os
import subprocess
from pathlib import Path
import time

# Windows subprocess flags to prevent CMD window flashing
SUBPROCESS_FLAGS = {}
if sys.platform == 'win32':
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    SUBPROCESS_FLAGS = {
        'startupinfo': startupinfo,
        'creationflags': subprocess.CREATE_NO_WINDOW
    }

def log(message):
    """Print log message"""
    try:
        print(f"[LAUNCHER] {message}")
    except UnicodeEncodeError:
        # Windows consoles may default to cp1252; avoid crashing on ✓ etc.
        safe = str(message).replace("✓", "[OK]").replace("✗", "[FAIL]").replace("⚠", "[WARN]")
        print(f"[LAUNCHER] {safe}")

def find_venv_python():
    """Find venv Python executable"""
    llm_dir = Path(__file__).parent
    # Prefer env_key-based environments under LLM/.envs/<env_key>/.venv
    try:
        from system_detector import SystemDetector
        from core.profile_selector import ProfileSelector
        from setup_state import SetupStateManager
        from core.envs.env_key_resolver import encode_torch_mm

        setup_state = SetupStateManager()
        selected_gpu_index = setup_state.get_selected_gpu_index()
        override_profile = setup_state.get_selected_profile()

        detector = SystemDetector()
        hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)
        selector = ProfileSelector(llm_dir / "metadata" / "compatibility_matrix.json")
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
        env_key = f"tf-{accelerator}-t{t_enc}-base-stable" if t_enc else f"tf-{accelerator}-base-stable"

        venv_dir = llm_dir / ".envs" / env_key / ".venv"
        if sys.platform == 'win32':
            venv_python = venv_dir / "Scripts" / "python.exe"
        else:
            venv_python = venv_dir / "bin" / "python"
        if venv_python.exists():
            return venv_python
    except Exception:
        pass

    # Legacy fallback: LLM/.venv
    venv_dir = llm_dir / ".venv"
    if sys.platform == 'win32':
        venv_python = venv_dir / "Scripts" / "python.exe"
    else:
        venv_python = venv_dir / "bin" / "python"
    return venv_python if venv_python.exists() else None

def check_venv_health(venv_python):
    """Check if venv Python and PySide6 are working"""
    try:
        # Test if venv Python works
        result = subprocess.run(
            [str(venv_python), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            **SUBPROCESS_FLAGS
        )
        if result.returncode != 0:
            log("Venv Python check failed")
            return False
        
        # Test if PySide6 can be imported
        result = subprocess.run(
            [str(venv_python), "-c", "import PySide6.QtCore; print('OK')"],
            capture_output=True,
            text=True,
            timeout=10,
            **SUBPROCESS_FLAGS
        )
        if result.returncode != 0 or "OK" not in result.stdout:
            log("PySide6 check failed - dependencies broken")
            return False
        
        return True
    except Exception as e:
        log(f"Health check failed: {e}")
        return False

def run_dependency_check(venv_python):
    """Run check_dependencies.py"""
    llm_dir = Path(__file__).parent
    check_script = llm_dir / "check_dependencies.py"
    
    if not check_script.exists():
        log("Warning: check_dependencies.py not found, skipping check")
        return True
    
    try:
        log("Running dependency check...")
        result = subprocess.run(
            [str(venv_python), str(check_script)],
            capture_output=True,
            text=True,
            timeout=30,
            **SUBPROCESS_FLAGS
        )
        
        # Print output for debugging
        if result.stdout:
            for line in result.stdout.splitlines():
                print(f"  {line}")
        
        if result.returncode == 0:
            log("✓ Dependency check passed")
            return True
        else:
            log("✗ Dependency check failed")
            if result.stderr:
                for line in result.stderr.splitlines():
                    print(f"  ERROR: {line}")
            return False
    except Exception as e:
        log(f"Dependency check error: {e}")
        return False

def launch_installer():
    """Launch installer GUI"""
    llm_dir = Path(__file__).parent
    
    # Try run_installer.bat first (uses bootstrap)
    run_installer_bat = llm_dir / "run_installer.bat"
    if run_installer_bat.exists():
        log("Launching installer via run_installer.bat...")
        try:
            subprocess.Popen(
                [str(run_installer_bat)],
                cwd=str(llm_dir),
                **SUBPROCESS_FLAGS
            )
            return True
        except Exception as e:
            log(f"Failed to launch via batch file: {e}")
    
    # Fallback to installer_gui.py directly
    installer_gui = llm_dir / "installer_gui.py"
    if installer_gui.exists():
        log("Launching installer_gui.py...")
        try:
            # Use system Python to launch installer
            subprocess.Popen(
                [sys.executable, str(installer_gui)],
                cwd=str(llm_dir),
                **SUBPROCESS_FLAGS
            )
            return True
        except Exception as e:
            log(f"Failed to launch installer: {e}")
    
    log("ERROR: Could not find installer!")
    return False

def launch_app(venv_python):
    """Launch the main application"""
    llm_dir = Path(__file__).parent
    
    log("Launching application...")
    
    try:
        # Launch desktop_app.main
        result = subprocess.Popen(
            [str(venv_python), "-m", "desktop_app.main"],
            cwd=str(llm_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **SUBPROCESS_FLAGS
        )
        
        # Wait a moment to see if it crashes immediately
        time.sleep(2)
        if result.poll() is not None:
            # Process exited already - that's bad
            log("ERROR: Application exited immediately")
            stdout, stderr = result.communicate(timeout=1)
            if stderr:
                log(f"Error output: {stderr.decode('utf-8', errors='ignore')}")
            return False
        
        log("✓ Application launched successfully")
        return True
    except Exception as e:
        log(f"Failed to launch app: {e}")
        return False

def main():
    """Main launcher logic"""
    print("=" * 60)
    print("LLM FINE-TUNING STUDIO - PYTHON LAUNCHER")
    print("=" * 60)
    
    llm_dir = Path(__file__).parent
    log(f"LLM Directory: {llm_dir}")
    
    # Step 1: Check if venv exists
    log("\nStep 1: Checking virtual environment...")
    venv_python = find_venv_python()
    
    if not venv_python:
        log("✗ Virtual environment not found")
        log("Launching installer...")
        if launch_installer():
            log("Installer launched. Please complete setup and rerun launcher.")
            return 0
        else:
            log("ERROR: Could not launch installer!")
            input("Press Enter to exit...")
            return 1
    
    log(f"✓ Found venv: {venv_python}")
    
    # Step 2: Check venv health (PySide6, etc.)
    log("\nStep 2: Checking venv health...")
    if not check_venv_health(venv_python):
        log("✗ Virtual environment is broken")
        log("Launching installer to repair...")
        if launch_installer():
            log("Installer launched. Please complete repair and rerun launcher.")
            return 0
        else:
            log("ERROR: Could not launch installer!")
            input("Press Enter to exit...")
            return 1
    
    log("✓ Venv health check passed")
    
    # Step 3: Check dependencies
    log("\nStep 3: Checking dependencies...")
    deps_ok = run_dependency_check(venv_python)
    
    if not deps_ok:
        log("✗ Dependencies check failed")
        log("Launching installer to repair...")
        if launch_installer():
            log("Installer launched. Please complete repair and rerun launcher.")
            return 0
        else:
            log("ERROR: Could not launch installer!")
            input("Press Enter to exit...")
            return 1
    
    # Step 4: Launch application
    log("\nStep 4: Launching application...")
    if launch_app(venv_python):
        log("\nApplication is running.")
        log("You can close this window.")
        return 0
    else:
        log("\nERROR: Application failed to launch")
        log("Try running installer to repair the installation.")
        input("Press Enter to exit...")
        return 1

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nCancelled by user.")
        sys.exit(0)
    except Exception as e:
        print(f"\nLauncher error: {e}")
        import traceback
        traceback.print_exc()
        input("\nPress Enter to exit...")
        sys.exit(1)
