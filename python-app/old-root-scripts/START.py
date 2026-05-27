"""
FOOLPROOF LAUNCHER - Works on ANY Windows PC
No admin rights needed, no policy changes needed
"""
import sys
import subprocess
from pathlib import Path
import os

# Fix Windows console encoding for unicode characters
if sys.platform == "win32":
    try:
        # Try to use UTF-8 encoding
        sys.stdout.reconfigure(encoding='utf-8')
    except:
        # Fallback: don't use unicode characters
        pass

# Get the directory containing this script
ROOT_DIR = Path(__file__).parent.absolute()
LLM_DIR = ROOT_DIR / "LLM"
VENV_DIR = LLM_DIR / ".venv"
PYTHON_EXE = VENV_DIR / "Scripts" / "python.exe"
PYTHONW_EXE = VENV_DIR / "Scripts" / "pythonw.exe"

# Global to store found Python command
PYTHON_CMD = "python"

def show_error(title, message):
    """Show error dialog using native Windows MessageBox"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)  # MB_ICONERROR
    except:
        print(f"\n{'='*60}\n{title}\n{'='*60}\n{message}\n{'='*60}\n")
        input("Press Enter to exit...")

def show_info(title, message):
    """Show info dialog"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, message, title, 0x40)  # MB_ICONINFORMATION
    except:
        print(f"\n{message}\n")

def find_python():
    """Find Python executable - checks PATH and common install locations"""
    import winreg
    
    # Try common locations and PATH
    possible_locations = ["python", "python3"]
    
    print("  Checking Windows Registry...")
    # Check Windows Registry for Python installations
    try:
        # Check both HKEY_CURRENT_USER and HKEY_LOCAL_MACHINE
        for root_key in [winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE]:
            try:
                key = winreg.OpenKey(root_key, r"SOFTWARE\Python\PythonCore")
                i = 0
                while True:
                    try:
                        version = winreg.EnumKey(key, i)
                        version_key = winreg.OpenKey(key, version + r"\InstallPath")
                        install_path = winreg.QueryValue(version_key, None)
                        python_exe = Path(install_path) / "python.exe"
                        print(f"  Registry: {python_exe}")
                        if python_exe.exists():
                            possible_locations.append(str(python_exe))
                        i += 1
                    except OSError:
                        break
                winreg.CloseKey(key)
            except FileNotFoundError:
                pass
    except Exception as e:
        print(f"  Registry check error: {e}")
    
    print("  Checking common install locations...")
    # Check common install locations
    common_paths = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python",
        Path("C:/Python312"), Path("C:/Python311"), Path("C:/Python310"),
        Path("C:/Python39"), Path("C:/Python38"),
        Path(os.environ.get("PROGRAMFILES", "")) / "Python312",
        Path(os.environ.get("PROGRAMFILES", "")) / "Python311",
        Path(os.environ.get("PROGRAMFILES", "")) / "Python310",
    ]
    
    for base_path in common_paths:
        if base_path.exists():
            # Check direct python.exe
            python_exe = base_path / "python.exe"
            if python_exe.exists():
                print(f"  Found: {python_exe}")
                possible_locations.append(str(python_exe))
            # Also check subdirectories (Python3xx format)
            for subdir in base_path.iterdir():
                if subdir.is_dir():
                    python_exe = subdir / "python.exe"
                    if python_exe.exists():
                        print(f"  Found: {python_exe}")
                        possible_locations.append(str(python_exe))
    
    print(f"\n  Testing {len(possible_locations)} possible Python locations...")
    # Try each location
    for i, python_cmd in enumerate(possible_locations, 1):
        try:
            print(f"  [{i}] Trying: {python_cmd}")
            result = subprocess.run(
                [python_cmd, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
            )
            if result.returncode == 0:
                version = result.stdout.strip()
                print(f"  [OK] SUCCESS! {version}")
                return python_cmd
            else:
                print(f"  [X] Failed (exit code {result.returncode})")
        except FileNotFoundError:
            print(f"  [X] Not found")
        except Exception as e:
            print(f"  [X] Error: {e}")
    
    print("\n  No working Python installation found!")
    return None

def check_python():
    """Verify Python is available"""
    global PYTHON_CMD
    
    print("Searching for Python installation...")
    python_path = find_python()
    
    if python_path:
        PYTHON_CMD = python_path
        return True
    
    show_error(
        "Python Not Found",
        "Python 3.8 or higher is required but not found.\n\n"
        "Please install Python from:\n"
        "https://www.python.org/downloads/\n\n"
        "Make sure to check 'Add Python to PATH' during installation!\n\n"
        "(Alternatively, install to a standard location like C:\\Python312)"
    )
    return False

def setup_venv():
    """Create and setup virtual environment"""
    print("\n" + "="*60)
    print("FIRST-TIME SETUP")
    print("="*60)
    print("\nThis will take 2-3 minutes...")
    print("\n[1/3] Creating virtual environment...")
    
    try:
        subprocess.run(
            [PYTHON_CMD, "-m", "venv", str(VENV_DIR)],
            check=True,
            cwd=str(LLM_DIR)
        )
        print("[OK] Virtual environment created")
    except subprocess.CalledProcessError:
        show_error(
            "Setup Failed",
            "Could not create virtual environment.\n\n"
            "This might be caused by:\n"
            "- Corrupted Python installation\n"
            "- Insufficient disk space\n"
            "- Antivirus blocking Python\n\n"
            "Try running as Administrator."
        )
        return False
    
    print("\n[2/3] Upgrading pip...")
    try:
        subprocess.run(
            [str(PYTHON_EXE), "-m", "pip", "install", "--upgrade", "pip"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print("[OK] pip upgraded")
    except:
        print("! pip upgrade failed (not critical, continuing...)")
    
    print("\n[3/3] Installing GUI library (PySide6)...")
    try:
        subprocess.run(
            [str(PYTHON_EXE), "-m", "pip", "install", "PySide6==6.8.1"],
            check=True
        )
        print("[OK] PySide6 installed")
    except subprocess.CalledProcessError:
        show_error(
            "Setup Failed",
            "Could not install PySide6.\n\n"
            "This might be caused by:\n"
            "- No internet connection\n"
            "- Firewall/antivirus blocking downloads\n"
            "- PyPI server issues\n\n"
            "Check your internet connection and try again."
        )
        return False
    
    print("\n" + "="*60)
    print("[OK] SETUP COMPLETE!")
    print("="*60)
    print("\nStarting application...")
    
    # Create marker file
    (LLM_DIR / ".setup_complete").touch()
    return True

def launch_app():
    """Launch the main application"""
    # Change to LLM directory
    os.chdir(str(LLM_DIR))
    
    # Try to launch with pythonw (no console window)
    if PYTHONW_EXE.exists():
        python_exe = PYTHONW_EXE
        print("\nLaunching GUI (window will appear shortly)...")
        # Use Popen for non-blocking launch
        try:
            subprocess.Popen(
                [str(python_exe), "-m", "desktop_app.main"],
                cwd=str(LLM_DIR),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            print("[OK] Application started successfully!")
            print("\nThe GUI window should appear in a few seconds.")
            print("You can close this window.")
            return True
        except Exception as e:
            # Fall through to console mode
            pass
    
    # Console mode with error checking
    python_exe = PYTHON_EXE
    print("\nLaunching GUI in console mode...")
    
    try:
        # Launch the app and wait for it
        result = subprocess.run(
            [str(python_exe), "-m", "desktop_app.main"],
            cwd=str(LLM_DIR)
        )
        
        # Only show error if it exited with error code
        if result.returncode != 0:
            show_error(
                "Application Error",
                f"The application exited with an error (code {result.returncode}).\n\n"
                f"Check logs at:\n{LLM_DIR / 'logs' / 'app.log'}\n\n"
                "If the problem persists, try deleting the .venv folder\n"
                "and running this launcher again."
            )
            return False
        
        return True
        
    except FileNotFoundError:
        show_error(
            "Launch Failed",
            "Could not find the application files.\n\n"
            f"Expected location:\n{LLM_DIR / 'desktop_app' / 'main.py'}\n\n"
            "The installation may be corrupted."
        )
        return False
    except Exception as e:
        show_error(
            "Launch Failed",
            f"An unexpected error occurred:\n\n{str(e)}\n\n"
            "Try running as Administrator or check antivirus settings."
        )
        return False

def main():
    """Main launcher logic"""
    print("\n" + "="*60)
    print("LLM FINE-TUNING STUDIO - LAUNCHER")
    print("="*60)
    
    # Check if Python is available
    print("\nChecking Python installation...")
    if not check_python():
        print("[ERROR] Python check failed")
        sys.exit(1)
    
    # Check if we need first-time setup
    setup_needed = not VENV_DIR.exists() or not (LLM_DIR / ".setup_complete").exists()
    print(f"\nVirtual environment exists: {VENV_DIR.exists()}")
    print(f"Setup complete marker exists: {(LLM_DIR / '.setup_complete').exists()}")
    print(f"Setup needed: {setup_needed}")
    
    if setup_needed:
        if not setup_venv():
            print("[ERROR] Setup failed")
            input("\nPress Enter to exit...")
            sys.exit(1)
        print("\nNote: Additional ML dependencies will be installed")
        print("automatically when you first use training features.")
        input("\nPress Enter to continue...")
    
    # Launch the application
    print("\nAttempting to launch application...")
    success = launch_app()
    
    if not success:
        print("[ERROR] Launch failed")
        input("\nPress Enter to exit...")
        sys.exit(1)
    
    print("\nLauncher exiting (app is running in background)")
    sys.exit(0)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nCancelled by user.")
        sys.exit(0)
    except Exception as e:
        show_error("Launcher Error", f"Unexpected error:\n\n{str(e)}")
        input("\nPress Enter to exit...")
        sys.exit(1)

