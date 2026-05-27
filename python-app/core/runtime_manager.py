#!/usr/bin/env python3
"""
Runtime Manager - Manages Visual C++ Redistributables and other runtime dependencies
Part of the self-contained installation system
"""

import sys
import os
import subprocess
import urllib.request
import zipfile
import shutil
from pathlib import Path
from typing import Optional, Dict


class RuntimeManager:
    """Manages self-contained runtime dependencies (vcredist, etc.)"""
    
    # Visual C++ Redistributables info
    VCREDIST_INFO = {
        "url": "https://aka.ms/vs/17/release/vc_redist.x64.exe",
        "filename": "vc_redist.x64.exe",
        "dll_dir": "vcredist"
    }
    
    def __init__(self, root_dir: Path = None):
        """Initialize runtime manager
        
        Args:
            root_dir: Root directory where runtime/ will be created. Defaults to script directory.
        """
        if root_dir is None:
            # Default to LLM directory (parent of core/)
            root_dir = Path(__file__).parent.parent
        
        self.root_dir = Path(root_dir)
        self.runtime_dir = self.root_dir / "runtime"
        self.runtime_dir.mkdir(exist_ok=True)
        self.vcredist_dir = self.runtime_dir / self.VCREDIST_INFO["dll_dir"]
        self.vcredist_dir.mkdir(exist_ok=True)
    
    def get_vcredist_dlls(self) -> Optional[Path]:
        """Get path to Visual C++ Redistributables DLLs directory
        
        Returns:
            Path to DLLs directory, or None if not available
        """
        # Check if DLLs already extracted
        dll_files = list(self.vcredist_dir.glob("*.dll"))
        if dll_files:
            return self.vcredist_dir
        
        # Try to extract from system if available
        # Note: We can't easily extract from the installer without running it
        # For now, we'll check if system vcredist is installed and use that
        # In the future, we could bundle the DLLs directly
        
        # Check common vcredist locations
        common_paths = [
            Path("C:/Windows/System32/msvcp140.dll"),
            Path("C:/Windows/System32/vcruntime140.dll"),
            Path("C:/Windows/System32/vcruntime140_1.dll"),
        ]
        
        found_dlls = []
        for dll_path in common_paths:
            if dll_path.exists():
                # Copy to our runtime directory
                try:
                    shutil.copy2(dll_path, self.vcredist_dir / dll_path.name)
                    found_dlls.append(dll_path.name)
                except Exception as e:
                    print(f"[RUNTIME] WARNING: Could not copy {dll_path.name}: {e}")
        
        if found_dlls:
            print(f"[RUNTIME] Found {len(found_dlls)} Visual C++ DLLs in system")
            return self.vcredist_dir
        
        # If not found, return None (will need system installation or manual bundling)
        print(f"[RUNTIME] Visual C++ DLLs not found. System vcredist may need to be installed.")
        return None
    
    def download_vcredist_installer(self) -> Optional[Path]:
        """Download Visual C++ Redistributables installer
        
        Returns:
            Path to installer, or None if failed
        """
        installer_path = self.runtime_dir / self.VCREDIST_INFO["filename"]
        
        # Check if already downloaded
        if installer_path.exists():
            print(f"[RUNTIME] Using existing vcredist installer: {installer_path}")
            return installer_path
        
        print(f"[RUNTIME] Downloading Visual C++ Redistributables...")
        
        try:
            def show_progress(block_num, block_size, total_size):
                if total_size > 0:
                    percent = min(100, (block_num * block_size * 100) // total_size)
                    print(f"\r[RUNTIME] Downloading... {percent}%", end='', flush=True)
            
            urllib.request.urlretrieve(
                self.VCREDIST_INFO["url"],
                installer_path,
                show_progress
            )
            print()  # New line after progress
            print(f"[RUNTIME] Download complete: {installer_path}")
            return installer_path
        except Exception as e:
            print(f"[RUNTIME] ERROR: Failed to download vcredist: {e}")
            if installer_path.exists():
                installer_path.unlink()
            return None
    
    def install_vcredist_system(self) -> bool:
        """Install Visual C++ Redistributables system-wide (requires admin)
        
        Returns:
            True if successful, False otherwise
        """
        installer_path = self.download_vcredist_installer()
        if not installer_path:
            return False
        
        print(f"[RUNTIME] Installing Visual C++ Redistributables (system-wide, requires admin)...")
        
        try:
            # Run installer silently
            result = subprocess.run(
                [str(installer_path), "/install", "/quiet", "/norestart"],
                capture_output=True,
                text=True,
                timeout=300
            )
            
            if result.returncode == 0:
                print(f"[RUNTIME] Visual C++ Redistributables installed successfully")
                # Clean up installer
                if installer_path.exists():
                    installer_path.unlink()
                return True
            else:
                print(f"[RUNTIME] WARNING: vcredist installer returned code {result.returncode}")
                return False
        except Exception as e:
            print(f"[RUNTIME] ERROR: Failed to install vcredist: {e}")
            return False
    
    def setup_local_path(self) -> bool:
        """Setup local PATH for this process to include runtime DLLs
        
        Returns:
            True if successful, False otherwise
        """
        dll_dir = self.get_vcredist_dlls()
        if not dll_dir:
            return False
        
        # Add to PATH for current process
        current_path = os.environ.get("PATH", "")
        dll_path_str = str(dll_dir)
        
        if dll_path_str not in current_path:
            os.environ["PATH"] = f"{dll_path_str};{current_path}"
            print(f"[RUNTIME] Added {dll_dir} to PATH for this process")
            return True
        
        return True


def get_runtime_manager(root_dir: Path = None) -> RuntimeManager:
    """Get runtime manager instance
    
    Args:
        root_dir: Root directory. Defaults to LLM directory.
    
    Returns:
        RuntimeManager instance
    """
    return RuntimeManager(root_dir)


if __name__ == "__main__":
    # Test
    manager = RuntimeManager()
    dll_dir = manager.get_vcredist_dlls()
    if dll_dir:
        print(f"Visual C++ DLLs directory: {dll_dir}")
    else:
        print("Visual C++ DLLs not available locally")
