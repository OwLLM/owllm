#!/usr/bin/env python3
"""
Verification System - Validates installation integrity
Part of the Immutable Installer system
"""

import sys
import subprocess
import json
from pathlib import Path
from typing import Dict, List, Tuple, Optional


class VerificationError(Exception):
    """Raised when a critical verification check fails"""
    pass


class VerificationSystem:
    """
    Performs hard verification checks after installation.
    All critical checks must pass or installation is considered failed.
    """
    
    def __init__(self, manifest_path: Path, venv_python: Path):
        """
        Initialize verification system.
        
        Args:
            manifest_path: Path to dependencies.json manifest
            venv_python: Path to venv Python executable
        """
        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = json.load(f)
        
        self.venv_python = venv_python
        
        # Windows subprocess flags
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
            print(f"[VERIFY] {message}")
        except UnicodeEncodeError:
            safe_message = message.replace('✓', '[OK]').replace('✗', '[FAIL]').replace('⚠', '[WARN]')
            try:
                print(f"[VERIFY] {safe_message}")
            except Exception:
                pass
    
    def verify_all(self) -> Tuple[bool, List[str]]:
        """
        Run all verification tests from manifest.
        
        Returns:
            Tuple of (success: bool, error_messages: List[str])
        """
        self.log("Running verification tests...")
        
        errors = []
        tests = self.manifest.get("verification_tests", [])
        
        for test in tests:
            test_name = test.get("name", "unnamed_test")
            test_code = test.get("code", "")
            is_critical = test.get("critical", False)
            
            self.log(f"  Testing: {test_name}")
            
            success, output, error = self._run_test(test_code)
            
            if success:
                self.log(f"    ✓ {test_name}: {output.strip() if output else 'OK'}")
            else:
                error_msg = f"{test_name}: {error}"
                if is_critical:
                    self.log(f"    ✗ CRITICAL FAILURE: {test_name}")
                    self.log(f"      {error}")
                    errors.append(error_msg)
                else:
                    self.log(f"    ⚠ WARNING: {test_name} failed (non-critical)")
                    self.log(f"      {error}")
        
        if errors:
            return False, errors
        else:
            self.log("✓ All verification tests passed")
            return True, []
    
    def _run_test(self, code: str) -> Tuple[bool, str, str]:
        """
        Run a single verification test.
        
        Args:
            code: Python code to execute
        
        Returns:
            Tuple of (success: bool, stdout: str, stderr: str)
        """
        try:
            result = subprocess.run(
                [str(self.venv_python), "-c", code],
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                return True, result.stdout, ""
            else:
                error = result.stderr or result.stdout or "Unknown error"
                return False, "", error
                
        except subprocess.TimeoutExpired:
            return False, "", "Test timeout (30s)"
        except Exception as e:
            return False, "", f"Test exception: {str(e)}"
    
    def verify_torch_cuda(self) -> Tuple[bool, str]:
        """
        Verify torch with CUDA is properly installed.
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        code = """
import torch
import sys

# Check CUDA availability
if not torch.cuda.is_available():
    print("ERROR: torch.cuda.is_available() returned False", file=sys.stderr)
    sys.exit(1)

# Get torch version
torch_version = torch.__version__
cuda_version = torch.version.cuda

# Check device count
device_count = torch.cuda.device_count()
if device_count == 0:
    print("ERROR: No CUDA devices detected", file=sys.stderr)
    sys.exit(1)

# Get device name
device_name = torch.cuda.get_device_name(0)

print(f"torch {torch_version}")
print(f"CUDA {cuda_version}")
print(f"Devices: {device_count}")
print(f"Device 0: {device_name}")
"""
        
        success, output, error = self._run_test(code)
        
        if success:
            return True, output
        else:
            return False, f"Torch CUDA verification failed: {error}"
    
    def verify_transformers_import(self) -> Tuple[bool, str]:
        """
        Verify transformers critical imports work.
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        code = """
from transformers import PreTrainedModel, AutoModel, AutoTokenizer, AutoConfig
import transformers

print(f"transformers {transformers.__version__}")
print("PreTrainedModel: OK")
print("AutoModel: OK")
print("AutoTokenizer: OK")
print("AutoConfig: OK")
"""
        
        success, output, error = self._run_test(code)
        
        if success:
            return True, output
        else:
            return False, f"Transformers import verification failed: {error}"
    
    def verify_pyside6(self) -> Tuple[bool, str]:
        """
        Verify PySide6 and shiboken6 are properly installed (matches launcher health check).
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        code = r"""
import os
import sys
from pathlib import Path

def _print_diag():
    print(f"python={sys.executable}")
    print(f"version={sys.version}")
    print(f"platform={sys.platform}")

try:
    # Ensure the package directories are registered for DLL resolution on Windows.
    # This mitigates PATH pollution / conflicting Qt DLLs on some machines.
    import PySide6
    pyside_dir = Path(PySide6.__file__).resolve().parent
    print(f"pyside_dir={pyside_dir}")

    try:
        import shiboken6
        shiboken_dir = Path(shiboken6.__file__).resolve().parent
        print(f"shiboken_dir={shiboken_dir}")
    except Exception as e:
        shiboken_dir = None
        print(f"shiboken_import_error={e!r}")

    if sys.platform == "win32":
        try:
            os.add_dll_directory(str(pyside_dir))
        except Exception as e:
            print(f"add_dll_directory_pyside_failed={e!r}")
        if shiboken_dir:
            try:
                os.add_dll_directory(str(shiboken_dir))
            except Exception as e:
                print(f"add_dll_directory_shiboken_failed={e!r}")

    # Now try importing QtCore
    import PySide6.QtCore  # noqa: F401
    print("PySide6.QtCore: OK")
    sys.exit(0)

except ImportError as e:
    _print_diag()
    error_msg = str(e)
    if "shiboken" in error_msg.lower() or "does not exist" in error_msg.lower():
        print(f"ERROR: PySide6/shiboken6 import failed: {error_msg}", file=sys.stderr)
    else:
        print(f"ERROR: PySide6 import error: {error_msg}", file=sys.stderr)
    sys.exit(1)

except Exception as e:
    _print_diag()
    # Common on Windows when a dependent DLL loads but is missing an entry point.
    print(f"ERROR: PySide6 check failed: {e}", file=sys.stderr)
    sys.exit(1)
"""
        
        success, output, error = self._run_test(code)
        
        if success:
            return True, output
        else:
            return False, f"PySide6 verification failed: {error}"
    
    def verify_no_blacklisted_packages(self) -> Tuple[bool, str]:
        """
        Verify no blacklisted packages are installed.
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        blacklist = self.manifest.get("global_blacklist", [])
        
        code = f"""
import sys
import importlib.util

blacklist = {blacklist}
found = []

for pkg in blacklist:
    # Check both underscore and hyphen versions
    for pkg_variant in [pkg, pkg.replace('-', '_'), pkg.replace('_', '-')]:
        if importlib.util.find_spec(pkg_variant) is not None:
            found.append(pkg_variant)
            break

if found:
    print(f"ERROR: Blacklisted packages found: {{', '.join(found)}}", file=sys.stderr)
    sys.exit(1)

print("No blacklisted packages found")
"""
        
        success, output, error = self._run_test(code)
        
        if success:
            return True, ""
        else:
            return False, f"Blacklist check failed: {error}"
    
    def verify_gpu_memory_allocation(self) -> Tuple[bool, str]:
        """
        Verify GPU memory can be allocated (smoke test).
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        code = """
import torch

# Try to allocate a small tensor on GPU
try:
    device = torch.device("cuda:0")
    x = torch.randn(100, 100, device=device)
    y = x @ x.T
    result = y.sum().item()
    
    # Free memory
    del x, y
    torch.cuda.empty_cache()
    
    print(f"GPU allocation test passed (result: {result:.2f})")
    
except Exception as e:
    import sys
    print(f"ERROR: GPU allocation failed: {e}", file=sys.stderr)
    sys.exit(1)
"""
        
        success, output, error = self._run_test(code)
        
        if success:
            return True, output
        else:
            return False, f"GPU allocation test failed: {error}"
    
    def verify_package_versions(self, expected_versions: Dict[str, str]) -> Tuple[bool, List[str]]:
        """
        Verify specific package versions are installed.
        
        Args:
            expected_versions: Dict of package_name -> version_spec
        
        Returns:
            Tuple of (success: bool, error_messages: List[str])
        """
        errors = []
        
        for pkg_name, expected_version in expected_versions.items():
            code = f"""
import importlib.metadata

try:
    version = importlib.metadata.version("{pkg_name}")
    print(version)
except importlib.metadata.PackageNotFoundError:
    import sys
    print(f"ERROR: Package {pkg_name} not found", file=sys.stderr)
    sys.exit(1)
"""
            
            success, output, error = self._run_test(code)
            
            if not success:
                errors.append(f"{pkg_name}: {error}")
            else:
                actual_version = output.strip()
                # TODO: Add version comparison logic if needed
                self.log(f"    {pkg_name}: {actual_version}")
        
        if errors:
            return False, errors
        else:
            return True, []
    
    def run_quick_verify(self) -> Tuple[bool, str]:
        """
        Run quick verification (essential checks only).
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        self.log("Running quick verification...")
        
        # Check 1: torch CUDA
        success, result = self.verify_torch_cuda()
        if not success:
            return False, result
        
        # Check 2: transformers import
        success, result = self.verify_transformers_import()
        if not success:
            return False, result
        
        # Check 3: PySide6/shiboken6 (critical for launcher health check)
        success, result = self.verify_pyside6()
        if not success:
            return False, result
        
        # Check 4: no blacklisted packages
        success, result = self.verify_no_blacklisted_packages()
        if not success:
            return False, result
        
        self.log("✓ Quick verification passed")
        return True, ""


def main():
    """Test verification system"""
    import sys
    from pathlib import Path
    
    # Test setup
    manifest = Path(__file__).parent.parent / "metadata" / "dependencies.json"
    venv_python = Path(__file__).parent.parent / ".venv" / "Scripts" / "python.exe"
    
    if not manifest.exists():
        print(f"ERROR: Manifest not found at {manifest}")
        sys.exit(1)
    
    if not venv_python.exists():
        print(f"ERROR: Venv Python not found at {venv_python}")
        sys.exit(1)
    
    verifier = VerificationSystem(manifest, venv_python)
    
    print("Testing verification system...")
    success, errors = verifier.verify_all()
    
    if success:
        print("✓ All tests passed!")
    else:
        print("✗ Tests failed:")
        for error in errors:
            print(f"  - {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()

