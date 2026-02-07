#!/usr/bin/env python3
"""
Python Runtime Manager - Downloads and manages Python embeddable package
Part of the self-contained installation system
"""

import sys
import os
import subprocess
import zipfile
import urllib.request
import shutil
from pathlib import Path
from typing import Optional, Tuple


class PythonRuntimeManager:
    """Manages self-contained Python embeddable runtime"""
    
    # Python embeddable versions and URLs
    PYTHON_VERSIONS = {
        "3.12": {
            "version": "3.12.0",
            "url": "https://www.python.org/ftp/python/3.12.0/python-3.12.0-embed-amd64.zip",
            "filename": "python-3.12.0-embed-amd64.zip"
        },
        "3.11": {
            "version": "3.11.9",
            "url": "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip",
            "filename": "python-3.11.9-embed-amd64.zip"
        },
        "3.10": {
            "version": "3.10.11",
            "url": "https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip",
            "filename": "python-3.10.11-embed-amd64.zip"
        }
    }
    
    def __init__(self, root_dir: Path = None):
        """Initialize Python runtime manager
        
        Args:
            root_dir: Root directory where python_runtime/ will be created. Defaults to script directory.
        """
        if root_dir is None:
            # Default to LLM directory (parent of core/)
            root_dir = Path(__file__).parent.parent
        
        self.root_dir = Path(root_dir)
        self.runtime_dir = self.root_dir / "python_runtime"
        self.runtime_dir.mkdir(exist_ok=True)
    
    def get_python_runtime(self, version: str = "3.12") -> Optional[Path]:
        """Get path to Python executable, downloading if needed
        
        Args:
            version: Python version (3.10, 3.11, or 3.12)
        
        Returns:
            Path to Python executable, or None if failed
        """
        if version not in self.PYTHON_VERSIONS:
            raise ValueError(f"Unsupported Python version: {version}. Supported: {list(self.PYTHON_VERSIONS.keys())}")
        
        python_dir = self.runtime_dir / f"python{version}"
        python_exe = python_dir / "python.exe" if sys.platform == "win32" else python_dir / "python"
        
        # Check if already exists
        if python_exe.exists():
            # Ensure pip and virtualenv are available (embeddable runtime lacks stdlib venv)
            try:
                self._ensure_pip(python_dir, python_exe)
                self._ensure_virtualenv(python_dir, python_exe)
            except Exception:
                pass
            return python_exe
        
        # Download and extract
        print(f"[PYTHON-RUNTIME] Python {version} not found. Downloading...")
        zip_path = self.download_python_embeddable(version)
        if not zip_path:
            return None
        
        if not self.extract_python_embeddable(zip_path, python_dir):
            return None
        
        # Configure Python (uncomment import site in ._pth file)
        self._configure_python(python_dir, version)
        
        # Install pip if not present
        self._ensure_pip(python_dir, python_exe)

        # Embeddable Python does not include stdlib `venv`. We use `virtualenv` to create isolated envs.
        self._ensure_virtualenv(python_dir, python_exe)
        
        # Clean up zip file
        if zip_path.exists():
            zip_path.unlink()
        
        return python_exe if python_exe.exists() else None
    
    def download_python_embeddable(self, version: str = "3.12") -> Optional[Path]:
        """Download Python embeddable package
        
        Args:
            version: Python version (3.10, 3.11, or 3.12)
        
        Returns:
            Path to downloaded zip file, or None if failed
        """
        if version not in self.PYTHON_VERSIONS:
            raise ValueError(f"Unsupported Python version: {version}")
        
        info = self.PYTHON_VERSIONS[version]
        zip_path = self.runtime_dir / info["filename"]
        
        # Check if already downloaded
        if zip_path.exists():
            print(f"[PYTHON-RUNTIME] Using existing download: {zip_path}")
            return zip_path
        
        print(f"[PYTHON-RUNTIME] Downloading Python {version} embeddable from {info['url']}...")
        
        try:
            def show_progress(block_num, block_size, total_size):
                if total_size > 0:
                    percent = min(100, (block_num * block_size * 100) // total_size)
                    print(f"\r[PYTHON-RUNTIME] Downloading... {percent}%", end='', flush=True)
            
            urllib.request.urlretrieve(info["url"], zip_path, show_progress)
            print()  # New line after progress
            print(f"[PYTHON-RUNTIME] Download complete: {zip_path}")
            return zip_path
        except Exception as e:
            print(f"[PYTHON-RUNTIME] ERROR: Failed to download Python embeddable: {e}")
            if zip_path.exists():
                zip_path.unlink()
            return None
    
    def extract_python_embeddable(self, zip_path: Path, extract_to: Path) -> bool:
        """Extract Python embeddable package
        
        Args:
            zip_path: Path to zip file
            extract_to: Directory to extract to
        
        Returns:
            True if successful, False otherwise
        """
        if not zip_path.exists():
            print(f"[PYTHON-RUNTIME] ERROR: Zip file not found: {zip_path}")
            return False
        
        print(f"[PYTHON-RUNTIME] Extracting to {extract_to}...")
        
        try:
            extract_to.mkdir(parents=True, exist_ok=True)
            
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_to)
            
            print(f"[PYTHON-RUNTIME] Extraction complete")
            return True
        except Exception as e:
            print(f"[PYTHON-RUNTIME] ERROR: Failed to extract: {e}")
            return False
    
    def _configure_python(self, python_dir: Path, version: str):
        """Configure Python embeddable (uncomment import site)
        
        Args:
            python_dir: Directory containing Python
            version: Python version
        """
        # Find ._pth file (e.g., python312._pth)
        pth_file = python_dir / f"python{version.replace('.', '')}._pth"
        
        if not pth_file.exists():
            # Try alternative naming
            major, minor = version.split('.')[:2]
            pth_file = python_dir / f"python{major}{minor}._pth"
        
        if pth_file.exists():
            try:
                content = pth_file.read_text(encoding='utf-8')
                # Uncomment 'import site' line
                content = content.replace('#import site', 'import site')
                pth_file.write_text(content, encoding='utf-8')
                print(f"[PYTHON-RUNTIME] Configured {pth_file.name}")
            except Exception as e:
                print(f"[PYTHON-RUNTIME] WARNING: Could not configure {pth_file.name}: {e}")
    
    def _ensure_pip(self, python_dir: Path, python_exe: Path):
        """Ensure pip is installed in Python embeddable
        
        Args:
            python_dir: Directory containing Python
            python_exe: Path to Python executable
        """
        # Check if pip already exists
        pip_exe = python_dir / "Scripts" / "pip.exe" if sys.platform == "win32" else python_dir / "bin" / "pip"
        if pip_exe.exists():
            return
        
        print(f"[PYTHON-RUNTIME] Installing pip...")
        
        try:
            # Download get-pip.py
            get_pip_path = python_dir / "get-pip.py"
            if not get_pip_path.exists():
                urllib.request.urlretrieve(
                    "https://bootstrap.pypa.io/get-pip.py",
                    get_pip_path
                )
            
            # Run get-pip.py
            # Windows subprocess flags to prevent CMD window flashing
            subprocess_flags = {}
            if sys.platform == 'win32':
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = subprocess.SW_HIDE
                subprocess_flags = {
                    'startupinfo': startupinfo,
                    'creationflags': subprocess.CREATE_NO_WINDOW
                }

            result = subprocess.run(
                [str(python_exe), str(get_pip_path)],
                capture_output=True,
                text=True,
                timeout=300,
                **subprocess_flags
            )
            
            if result.returncode == 0:
                print(f"[PYTHON-RUNTIME] Pip installed successfully")
            else:
                print(f"[PYTHON-RUNTIME] WARNING: Pip installation had issues: {result.stderr[:200]}")
        except Exception as e:
            print(f"[PYTHON-RUNTIME] WARNING: Could not install pip: {e}")

    def _ensure_virtualenv(self, python_dir: Path, python_exe: Path):
        """Ensure virtualenv is installed in Python runtime.

        The embeddable Python distribution does not ship the stdlib `venv` module, so we
        rely on `virtualenv` to create isolated environments.
        """
        # Windows subprocess flags to prevent CMD window flashing
        subprocess_flags = {}
        if sys.platform == 'win32':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }

        try:
            probe = subprocess.run(
                [str(python_exe), "-c", "import virtualenv; print('OK')"],
                capture_output=True,
                text=True,
                timeout=20,
                **subprocess_flags
            )
            if probe.returncode == 0 and "OK" in (probe.stdout or ""):
                return
        except Exception:
            pass

        print(f"[PYTHON-RUNTIME] Installing virtualenv...")
        try:
            result = subprocess.run(
                [str(python_exe), "-m", "pip", "install", "--upgrade", "virtualenv", "-q"],
                capture_output=True,
                text=True,
                timeout=300,
                **subprocess_flags
            )
            if result.returncode == 0:
                print(f"[PYTHON-RUNTIME] virtualenv installed successfully")
            else:
                err = (result.stderr or result.stdout or "").strip()
                print(f"[PYTHON-RUNTIME] WARNING: virtualenv installation had issues: {err[:200]}")
        except Exception as e:
            print(f"[PYTHON-RUNTIME] WARNING: Could not install virtualenv: {e}")


def get_python_runtime(version: str = "3.12", root_dir: Path = None) -> Optional[Path]:
    """Convenience function to get Python runtime
    
    Args:
        version: Python version (3.10, 3.11, or 3.12)
        root_dir: Root directory. Defaults to LLM directory.
    
    Returns:
        Path to Python executable, or None if failed
    """
    manager = PythonRuntimeManager(root_dir)
    return manager.get_python_runtime(version)


if __name__ == "__main__":
    # Test
    manager = PythonRuntimeManager()
    python_exe = manager.get_python_runtime("3.12")
    if python_exe:
        print(f"Python runtime ready at: {python_exe}")
        # Test Python
        # Windows subprocess flags to prevent CMD window flashing
        subprocess_flags = {}
        if sys.platform == 'win32':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }
            
        result = subprocess.run([str(python_exe), "--version"], capture_output=True, text=True, **subprocess_flags)
        print(f"Python version: {result.stdout.strip()}")
    else:
        print("Failed to get Python runtime")
