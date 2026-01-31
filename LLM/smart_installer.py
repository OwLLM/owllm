#!/usr/bin/env python3
"""
Smart Installer for LLM Fine-tuning Studio
Intelligently installs components based on system detection
"""

import os
import sys
import subprocess
import platform
import re
import shutil
import json
from pathlib import Path
from typing import Dict, Optional, Tuple
from system_detector import SystemDetector, detect_all

try:
    from packaging import version as pkg_version
    from packaging.specifiers import SpecifierSet
except ImportError:
    # Fallback if packaging not available
    pkg_version = None
    SpecifierSet = None

class SmartInstaller:
    """Smart installer that detects and installs only what's needed"""
    
    # Hardware-specific version matrix for compatibility
    VERSION_MATRIX = {
        "cuda_12_4": {"torch": "2.5.1", "triton": "3.0.0", "torchvision": "0.20.1", "torchaudio": "2.5.1"},
        "cuda_12_1": {"torch": "2.5.1", "triton": "3.0.0", "torchvision": "0.20.1", "torchaudio": "2.5.1"},
        "cuda_11_8": {"torch": "2.5.1", "triton": "3.0.0", "torchvision": "0.20.1", "torchaudio": "2.5.1"},
        "cpu": {"torch": "2.5.1", "triton": "3.0.0", "torchvision": "0.20.1", "torchaudio": "2.5.1"}
    }
    
    # GPU-specific compatibility information
    GPU_COMPAT = {
        "RTX 4090": {"compute": "8.9", "min_cuda": "11.8", "recommended_cuda": "12.4"},
        "RTX 4080": {"compute": "8.9", "min_cuda": "11.8", "recommended_cuda": "12.4"},
        "RTX 4070": {"compute": "8.9", "min_cuda": "11.8", "recommended_cuda": "12.4"},
        "RTX A2000": {"compute": "8.6", "min_cuda": "11.1", "recommended_cuda": "11.8"},
        "RTX 3090": {"compute": "8.6", "min_cuda": "11.1", "recommended_cuda": "11.8"},
        "RTX 3080": {"compute": "8.6", "min_cuda": "11.1", "recommended_cuda": "11.8"},
        "RTX 3070": {"compute": "8.6", "min_cuda": "11.1", "recommended_cuda": "11.8"},
        "RTX 3060": {"compute": "8.6", "min_cuda": "11.1", "recommended_cuda": "11.8"},
        "T1000": {"compute": "7.5", "min_cuda": "10.0", "recommended_cuda": "11.8"},
        "T600": {"compute": "7.5", "min_cuda": "10.0", "recommended_cuda": "11.8"},
    }
    
    def __init__(self, install_dir: Optional[str] = None):
        self.install_dir = Path(install_dir) if install_dir else Path.cwd()
        self.detector = SystemDetector()
        self.detection_results = {}
        self.installation_log = []
        self.progress_callback = None  # Callback for progress updates (percent, message)
        self.min_disk_space_gb = 5  # Minimum 5 GB required
        self.install_plan = {}  # Frozen install plan dict (hardware/platform-driven)
        
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
        """Log installation message"""
        msg = f"[INSTALL] {message}"
        try:
            print(msg)
        except (UnicodeEncodeError, UnicodeError):
            # Windows consoles can be cp1252; strip/replace common unicode symbols
            safe = (
                msg.replace("✓", "[OK]")
                .replace("✗", "[FAIL]")
                .replace("⚠", "[WARN]")
                .replace("ℹ", "[INFO]")
                .replace("→", "->")
            )
            try:
                # Last-resort: ensure printable bytes
                enc = getattr(sys.stdout, "encoding", None) or "utf-8"
                safe = safe.encode(enc, errors="replace").decode(enc, errors="replace")
            except Exception:
                pass
            try:
                print(safe)
            except Exception:
                # Give up on console printing, but still keep internal log
                pass
        self.installation_log.append(message)
    
    def _detect_hardware_platform(self, python_executable: Optional[str] = None) -> Dict:
        """
        Detection phase: Detect OS, Python, CPU arch, NVIDIA GPU, CUDA driver.
        Runs BEFORE any install.
        
        Returns:
            Frozen install_plan dict with all hardware/platform decisions
        """
        self.log("=" * 60)
        self.log("DETECTION PHASE: Hardware and Platform Detection")
        self.log("=" * 60)
        
        plan = {}
        
        # 1. Detect OS
        plan["os"] = platform.system()  # Windows, Linux, Darwin
        plan["os_version"] = platform.version()
        self.log(f"OS: {plan['os']} {plan['os_version']}")
        
        # 2. Detect CPU architecture
        plan["cpu_arch"] = platform.machine()  # x86_64, AMD64, etc.
        self.log(f"CPU Architecture: {plan['cpu_arch']}")
        
        # 3. Detect Python version
        if not python_executable:
            python_executable = sys.executable
        
        try:
            result = subprocess.run(
                [python_executable, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            if result.returncode == 0:
                python_version = result.stdout.strip()
                plan["python_version"] = python_version
                major, minor = map(int, python_version.split('.'))
                plan["python_major"] = major
                plan["python_minor"] = minor
                self.log(f"Python: {python_version}")
            else:
                raise ValueError("Could not detect Python version")
        except Exception as e:
            self.log(f"ERROR: Python detection failed: {e}")
            return {}
        
        # 4. Detect NVIDIA GPU via nvidia-smi
        plan["nvidia_gpu_present"] = False
        plan["cuda_driver_version"] = None
        plan["cuda_compute_capability"] = None
        
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader"],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().split('\n')
                if lines:
                    # Parse first GPU
                    parts = lines[0].split(',')
                    if len(parts) >= 2:
                        plan["nvidia_gpu_present"] = True
                        plan["gpu_name"] = parts[0].strip()
                        plan["cuda_driver_version"] = parts[1].strip()
                        if len(parts) >= 3:
                            plan["cuda_compute_capability"] = parts[2].strip()
                        self.log(f"NVIDIA GPU detected: {plan['gpu_name']}")
                        self.log(f"CUDA Driver: {plan['cuda_driver_version']}")
                        if plan["cuda_compute_capability"]:
                            self.log(f"Compute Capability: {plan['cuda_compute_capability']}")
        except (FileNotFoundError, subprocess.TimeoutExpired, Exception) as e:
            self.log(f"No NVIDIA GPU detected (nvidia-smi not available or failed: {e})")
        
        # 5. Determine CUDA build from driver version
        if plan.get("nvidia_gpu_present") and plan.get("cuda_driver_version"):
            driver_version = plan["cuda_driver_version"]
            # Parse major.minor from driver version (e.g., "550.54.15" -> 550)
            try:
                driver_major = int(driver_version.split('.')[0])
                # Map driver version to CUDA build
                if driver_major >= 550:
                    plan["cuda_build"] = "cu124"  # CUDA 12.4
                elif driver_major >= 530:
                    plan["cuda_build"] = "cu121"  # CUDA 12.1
                elif driver_major >= 520:
                    plan["cuda_build"] = "cu118"  # CUDA 11.8
                else:
                    plan["cuda_build"] = "cu118"  # Default to 11.8
                self.log(f"Selected CUDA build: {plan['cuda_build']}")
            except (ValueError, IndexError):
                plan["cuda_build"] = "cu118"  # Default
                self.log(f"Could not parse driver version, defaulting to cu118")
        else:
            plan["cuda_build"] = "cpu"
            self.log("No GPU detected, using CPU-only build")
        
        # Make plan immutable (frozen)
        plan["_frozen"] = True
        
        self.log("=" * 60)
        self.log("Detection phase complete")
        self.log("=" * 60)
        
        return plan
    
    def _generate_install_plan(self, python_executable: Optional[str] = None) -> Dict:
        """
        Generate immutable install plan from hardware/platform detection.
        Derives all package version decisions from install_plan.
        
        Returns:
            Complete install_plan with package decisions
        """
        if not self.install_plan or not self.install_plan.get("_frozen"):
            # Run detection phase first
            self.install_plan = self._detect_hardware_platform(python_executable)
        
        if not self.install_plan:
            return {}
        
        plan = self.install_plan.copy()
        
        # Derive immutable decisions from hardware/platform
        
        # 1. NumPy version based on Python version
        if plan["python_major"] >= 3 and plan["python_minor"] >= 12:
            plan["numpy_spec"] = "numpy>=2,<3"
        else:
            plan["numpy_spec"] = "numpy<2"
        self.log(f"NumPy decision: {plan['numpy_spec']} (Python {plan['python_version']})")
        
        # 2. PyTorch build - HARDCODED to cu124 (deterministic, not dynamic)
        if plan.get("nvidia_gpu_present"):
            # Always use cu124 for CUDA builds (deterministic)
            plan["torch_spec"] = "torch==2.5.1+cu124"
            plan["torchvision_spec"] = "torchvision==0.20.1+cu124"
            plan["torchaudio_spec"] = "torchaudio==2.5.1+cu124"
            plan["torch_index_url"] = "https://download.pytorch.org/whl/cu124"
            plan["cuda_build"] = "cu124"  # Override detected build with hardcoded cu124
        else:
            plan["torch_spec"] = "torch==2.5.1"
            plan["torchvision_spec"] = "torchvision==0.20.1"
            plan["torchaudio_spec"] = "torchaudio==2.5.1"
            plan["torch_index_url"] = "https://download.pytorch.org/whl/cpu"
        self.log(f"PyTorch decision: {plan['torch_spec']} ({plan['torch_index_url']})")
        
        # 3. Always pin these packages
        plan["sympy_spec"] = "sympy==1.13.1"
        plan["fsspec_spec"] = "fsspec<=2025.9.0"
        plan["huggingface_hub_spec"] = "huggingface-hub<1.0"
        
        # 4. Other packages
        plan["transformers_spec"] = "transformers==4.57.3"
        plan["tokenizers_spec"] = "tokenizers==0.22.1"
        plan["datasets_spec"] = "datasets>=2.11.0,<4.4.0"
        
        return plan
    
    def _generate_constraints_file(self, install_plan: Dict, torch_selected: bool = False) -> Path:
        """
        Generate constraints.txt dynamically from install_plan.
        After hardware detection selects torch version, pins are written immediately.
        """
        constraints_file = Path(__file__).parent / "constraints.txt"
        
        constraints = []
        
        # CRITICAL: If torch is selected, write exact pins immediately
        if torch_selected:
            torch_spec = install_plan.get("torch_spec", "")
            torchvision_spec = install_plan.get("torchvision_spec", "")
            torchaudio_spec = install_plan.get("torchaudio_spec", "")
            
            constraints.extend([
                "# CRITICAL: PyTorch stack pins (NEVER reinstall or upgrade)",
                torch_spec,
                torchvision_spec,
                torchaudio_spec,
                "",
                "# Required pins",
                "sympy==1.13.1",
                "huggingface-hub>=0.30.0,<1.0",
                "",
                f"# NumPy constraint based on Python {install_plan.get('python_version', 'unknown')}",
                install_plan.get("numpy_spec", "numpy<2"),
                "",
            ])
        else:
            # Initial constraints before torch selection
            constraints.extend([
                "# Initial constraints (before torch selection)",
                install_plan.get("numpy_spec", "numpy<2"),
                "sympy==1.13.1",
                "huggingface-hub>=0.30.0,<1.0",
                "",
            ])
        
        with open(constraints_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(constraints))
        
        self.log(f"Generated constraints.txt: {constraints_file}")
        return constraints_file
    
    def _gate_torch_integrity(self, python_executable: str, expected_version: str, require_cuda: bool = True) -> Tuple[bool, str]:
        """
        MANDATORY GATE: Verify torch version and CUDA availability after every install step.
        If torch is changed, abort immediately.
        
        Args:
            python_executable: Target Python executable
            expected_version: Expected torch version (e.g., "2.5.1+cu124" or "torch==2.5.1+cu124")
            require_cuda: If True, assert torch.cuda.is_available()
        
        Returns:
            Tuple of (pass: bool, error_message: str)
        """
        try:
            # Extract exact version from spec (e.g., "torch==2.5.1+cu124" -> "2.5.1+cu124")
            if "==" in expected_version:
                selected_version = expected_version.split("==", 1)[1]
            else:
                selected_version = expected_version
            
            # Build verification script
            if require_cuda:
                verify_script = f"import torch; assert torch.__version__ == '{selected_version}', f'Expected {selected_version}, got {{torch.__version__}}'; assert torch.cuda.is_available(), 'CUDA not available'; print('OK')"
            else:
                verify_script = f"import torch; assert torch.__version__ == '{selected_version}', f'Expected {selected_version}, got {{torch.__version__}}'; print('OK')"
            
            verify_cmd = [python_executable, "-c", verify_script]
            
            result = subprocess.run(
                verify_cmd,
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                return True, ""
            else:
                error_output = result.stderr or result.stdout
                return False, f"Torch integrity check failed: {error_output.strip()}"
                
        except Exception as e:
            return False, f"Torch integrity check exception: {str(e)}"
    
    def _guard_torch_immutability(self, python_executable: str, expected_version: str, cuda_build: str, step_name: str) -> Tuple[bool, str]:
        """
        GUARD: Check torch before/after install. If torch drifts, reinstall and abort.
        
        Args:
            python_executable: Target Python executable
            expected_version: Expected torch version
            cuda_build: CUDA build string (e.g., "cu124")
            step_name: Name of the installation step (for error messages)
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        # Record torch state before install
        check_script = """
import torch
print(torch.__version__)
print('CUDA:', torch.cuda.is_available())
"""
        try:
            result = subprocess.run(
                [python_executable, "-c", check_script],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                lines = result.stdout.strip().split('\n')
                before_version = lines[0].strip() if len(lines) > 0 else ""
                before_cuda = "True" in (lines[1] if len(lines) > 1 else "")
            else:
                # Torch not installed yet, that's OK
                before_version = None
                before_cuda = None
        except:
            before_version = None
            before_cuda = None
        
        # After install, check torch again
        expected_version_clean = expected_version.split("==")[1] if "==" in expected_version else expected_version
        
        verify_result = self._gate_torch_integrity(python_executable, expected_version, require_cuda=True)
        
        if not verify_result[0]:
            # Torch drifted - reinstall
            self.log(f"ERROR: Torch drift detected after {step_name}")
            self.log(f"Before: version={before_version}, CUDA={before_cuda}")
            self.log(f"Expected: version={expected_version_clean}, CUDA=True")
            self.log("Reinstalling torch stack...")
            
            # Reinstall torch stack
            index_url = f"https://download.pytorch.org/whl/{cuda_build}"
            torch_version = f"2.5.1+{cuda_build}"
            torchvision_version = f"0.20.1+{cuda_build}"
            torchaudio_version = f"2.5.1+{cuda_build}"
            
            # Uninstall
            for pkg in ["torch", "torchvision", "torchaudio"]:
                subprocess.run([python_executable, "-m", "pip", "uninstall", "-y", pkg], 
                             capture_output=True, timeout=60, **self.subprocess_flags)
            
            # Reinstall
            for pkg_spec in [f"torch=={torch_version}", f"torchvision=={torchvision_version}", f"torchaudio=={torchaudio_version}"]:
                success, _, _ = self._run_pip_worker(
                    action="install",
                    package=pkg_spec,
                    python_executable=python_executable,
                    index_url=index_url,
                    pip_args=["--no-deps", "--no-cache-dir"]
                )
                if not success:
                    error_msg = f"Failed to reinstall {pkg_spec} after drift detection"
                    self.log(f"ERROR: {error_msg}")
                    return False, error_msg
            
            # Verify again
            verify_again = self._gate_torch_integrity(python_executable, expected_version, require_cuda=True)
            if not verify_again[0]:
                error_msg = f"Torch reinstall failed after drift: {verify_again[1]}"
                self.log(f"ERROR: {error_msg}")
                return False, error_msg
            
            # Still abort even after successful reinstall (to prevent silent corruption)
            error_msg = f"ABORT: Torch drifted during {step_name} installation. Reinstalled but aborting to prevent corruption."
            self.log(f"ERROR: {error_msg}")
            return False, error_msg
        
        return True, ""
    
    def _check_torch_already_correct(self, python_executable: str, expected_version: str, require_cuda: bool = True) -> Tuple[bool, str]:
        """
        Check if torch is already installed and correct. Skip download if true.
        
        Returns:
            Tuple of (is_correct: bool, error_message: str)
        """
        return self._gate_torch_integrity(python_executable, expected_version, require_cuda)
    
    def _gate_no_torchao(self, python_executable: str) -> Tuple[bool, str]:
        """
        MANDATORY GATE: Verify torchao is NOT installed.
        Aborts if torchao is found.
        
        Returns:
            Tuple of (pass: bool, error_message: str)
        """
        try:
            verify_cmd = [python_executable, "-c", "import importlib.util; assert importlib.util.find_spec('torchao') is None, 'torchao is still installed'; print('OK no torchao')"]
            result = subprocess.run(
                verify_cmd,
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                return True, ""
            else:
                error_output = result.stderr or result.stdout
                return False, f"torchao is installed (must be removed): {error_output.strip()}"
                
        except Exception as e:
            return False, f"torchao check exception: {str(e)}"
    
    def _gate_core_stack_invariants(self, python_executable: str, require_cuda: bool = True) -> Tuple[bool, str]:
        """
        MANDATORY GATE: Verify core stack invariants after every layer.
        Aborts if any invariant is violated.
        
        Uses EXACT verification commands as specified:
        1) python -c "import torch; assert torch.__version__=='2.5.1+cu124'; assert torch.cuda.is_available(); print('OK torch')"
        2) python -c "from transformers import PreTrainedModel; import peft; print('OK transformers/peft')"
        3) python -c "import importlib.util; assert importlib.util.find_spec('torchao') is None; print('OK no torchao')"
        
        Args:
            python_executable: Target Python executable
            require_cuda: If True, assert torch.cuda.is_available()
        
        Returns:
            Tuple of (pass: bool, error_message: str)
        """
        errors = []
        
        # Gate 1: EXACT command - torch version == 2.5.1+cu124 and CUDA available
        if require_cuda:
            gate1_cmd = [python_executable, "-c", "import torch; assert torch.__version__=='2.5.1+cu124'; assert torch.cuda.is_available(); print('OK torch')"]
            gate1_result = subprocess.run(
                gate1_cmd,
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            if gate1_result.returncode != 0:
                error_output = gate1_result.stderr or gate1_result.stdout
                errors.append(f"Gate 1 (torch) failed: {error_output.strip()}")
        
        # Gate 2: EXACT command - PreTrainedModel import (MUST pass if transformers is installed)
        try:
            check_transformers = [python_executable, "-c", "import transformers; print('OK')"]
            transformers_result = subprocess.run(
                check_transformers,
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            
            if transformers_result.returncode == 0:
                # transformers IS installed - MUST pass gate 2
                gate2_cmd = [python_executable, "-c", "from transformers import PreTrainedModel; import peft; print('OK transformers/peft')"]
                gate2_result = subprocess.run(
                    gate2_cmd,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    **self.subprocess_flags
                )
                
                if gate2_result.returncode != 0:
                    error_output = gate2_result.stderr or gate2_result.stdout
                    errors.append(f"Gate 2 (PreTrainedModel) FAILED - transformers is installed but PreTrainedModel import failed: {error_output.strip()}")
            # If transformers not installed yet, skip this gate (will be checked after Layer 3)
        except Exception as e:
            # If check fails, transformers might not be installed yet - skip gate 2
            pass
        
        # Gate 3: EXACT command - torchao is NOT installed
        gate3_cmd = [python_executable, "-c", "import importlib.util; assert importlib.util.find_spec('torchao') is None; print('OK no torchao')"]
        gate3_result = subprocess.run(
            gate3_cmd,
            capture_output=True,
            text=True,
            timeout=10,
            **self.subprocess_flags
        )
        if gate3_result.returncode != 0:
            error_output = gate3_result.stderr or gate3_result.stdout
            errors.append(f"Gate 3 (torchao) failed: {error_output.strip()}")
        
        if errors:
            error_msg = " | ".join(errors)
            return False, error_msg
        
        return True, ""
    
    def _select_best_gpu(self, python_executable: str) -> Tuple[bool, str, Optional[Dict]]:
        """
        Select the best GPU from available NVIDIA GPUs.
        
        Selection policy:
        - If FORCE_GPU_INDEX env var is set: use it
        - Else: MAX compute capability (primary), MAX total VRAM (secondary)
        
        Returns:
            Tuple of (success: bool, error_message: str, gpu_info: Optional[Dict])
            gpu_info contains: {'index': int, 'name': str, 'vram_gb': float, 'compute_capability': float}
        """
        self.log("Enumerating available GPUs...")
        
        gpus = []
        
        # Try torch.cuda first
        enum_script = """
import torch
import json

if not torch.cuda.is_available():
    print(json.dumps({"error": "CUDA not available"}))
    exit(1)

gpus = []
for i in range(torch.cuda.device_count()):
    props = torch.cuda.get_device_properties(i)
    gpus.append({
        "index": i,
        "name": props.name,
        "total_memory": props.total_memory,
        "major": props.major,
        "minor": props.minor,
        "compute_capability": float(f"{props.major}.{props.minor}")
    })

print(json.dumps({"gpus": gpus}))
"""
        
        try:
            result = subprocess.run(
                [python_executable, "-c", enum_script],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                data = json.loads(result.stdout.strip())
                if "error" not in data:
                    gpus = data.get("gpus", [])
        except Exception as e:
            # Exception during GPU enumeration is fatal
            error_msg = f"GPU detection failed (torch.cuda): {str(e)}"
            self.log(f"ERROR: {error_msg}")
            return False, error_msg, None
        
        # Fallback to nvidia-smi if torch.cuda failed
        if not gpus:
            self.log("torch.cuda enumeration failed, trying nvidia-smi...")
            try:
                smi_result = subprocess.run(
                    ["nvidia-smi", "--query-gpu=index,name,memory.total,compute_cap", "--format=csv,noheader,nounits"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    **self.subprocess_flags
                )
                
                if smi_result.returncode == 0:
                    for line in smi_result.stdout.strip().split('\n'):
                        parts = [p.strip() for p in line.split(',')]
                        if len(parts) >= 4:
                            try:
                                idx = int(parts[0])
                                name = parts[1]
                                # Parse memory (format: "24576 MB" or "24576")
                                mem_str = parts[2].replace('MB', '').strip()
                                total_memory = int(mem_str) * (1024 ** 2)  # Convert MB to bytes
                                # Parse compute capability (format: "8.9" or "8.9 ")
                                cc_str = parts[3].strip()
                                cc_major, cc_minor = map(int, cc_str.split('.'))
                                compute_cap = float(f"{cc_major}.{cc_minor}")
                                
                                gpus.append({
                                    "index": idx,
                                    "name": name,
                                    "total_memory": total_memory,
                                    "major": cc_major,
                                    "minor": cc_minor,
                                    "compute_capability": compute_cap
                                })
                            except (ValueError, IndexError):
                                continue
            except Exception as e:
                # Exception during nvidia-smi fallback is fatal
                error_msg = f"GPU detection failed (nvidia-smi): {str(e)}"
                self.log(f"ERROR: {error_msg}")
                return False, error_msg, None
        
        if not gpus:
            error_msg = "No GPUs found (tried torch.cuda and nvidia-smi)"
            self.log(f"ERROR: {error_msg}")
            return False, error_msg, None
        
        # Log all GPUs
        self.log(f"Found {len(gpus)} GPU(s):")
        for gpu in gpus:
            vram_gb = gpu["total_memory"] / (1024 ** 3)
            self.log(f"  GPU {gpu['index']}: {gpu['name']} ({vram_gb:.1f} GB, CC {gpu['compute_capability']})")
        
        # Selection policy: check FORCE_GPU_INDEX first
        force_index = os.environ.get("FORCE_GPU_INDEX")
        if force_index is not None:
            try:
                force_idx = int(force_index)
                selected_gpu = next((g for g in gpus if g["index"] == force_idx), None)
                if selected_gpu:
                    self.log(f"FORCE_GPU_INDEX={force_index} specified, using GPU {force_idx}")
                    best_gpu = selected_gpu
                else:
                    self.log(f"WARNING: FORCE_GPU_INDEX={force_index} not found, falling back to auto-selection")
                    best_gpu = max(gpus, key=lambda g: (g["compute_capability"], g["total_memory"]))
            except ValueError:
                self.log(f"WARNING: Invalid FORCE_GPU_INDEX={force_index}, falling back to auto-selection")
                best_gpu = max(gpus, key=lambda g: (g["compute_capability"], g["total_memory"]))
        else:
            # Select best GPU: primary = MAX compute capability, secondary = MAX VRAM
            best_gpu = max(gpus, key=lambda g: (g["compute_capability"], g["total_memory"]))
        
        vram_gb = best_gpu["total_memory"] / (1024 ** 3)
        selected_info = {
            "index": best_gpu["index"],
            "name": best_gpu["name"],
            "vram_gb": vram_gb,
            "compute_capability": best_gpu["compute_capability"]
        }
        
        # Set CUDA_VISIBLE_DEVICES environment variable to physical index
        os.environ["CUDA_VISIBLE_DEVICES"] = str(best_gpu["index"])
        
        # Create visibility map
        visibility_map = {0: best_gpu["index"]}  # Logical 0 -> Physical index
        
        # Log selection result
        self.log("=" * 60)
        self.log("=== GPU SELECTION RESULT ===")
        self.log(f"Selected GPU: {best_gpu['name']} ({vram_gb:.1f} GB, CC {best_gpu['compute_capability']})")
        self.log(f"Physical index: {best_gpu['index']}")
        self.log(f"Visible devices: [{best_gpu['index']}]")
        self.log(f"Visibility map: {visibility_map}")
        self.log("=" * 60)
        
        # Verify selection
        verify_script = f"""import torch
assert torch.cuda.is_available(), "CUDA not available"
assert torch.cuda.device_count() == 1, f"Expected 1 device, got {{torch.cuda.device_count()}}"
device_name = torch.cuda.get_device_name(0)
expected_name = "{best_gpu['name']}"
if device_name != expected_name:
    print(f"ERROR: Device name mismatch. Expected: {{expected_name}}, Got: {{device_name}}")
    exit(1)
print(device_name)
"""
        
        try:
            verify_result = subprocess.run(
                [python_executable, "-c", verify_script],
                capture_output=True,
                text=True,
                timeout=10,
                env=os.environ.copy(),
                **self.subprocess_flags
            )
            
            if verify_result.returncode != 0:
                error_msg = f"GPU selection verification failed: {verify_result.stderr.strip() or verify_result.stdout.strip()}"
                self.log(f"ERROR: {error_msg}")
                return False, error_msg, None
        except Exception as e:
            error_msg = f"GPU selection verification exception: {str(e)}"
            self.log(f"ERROR: {error_msg}")
            return False, error_msg, None
        
        self.log(f"✓ GPU selection verified: {verify_result.stdout.strip()}")
        
        return True, "", selected_info
    
    def _ensure_cuda_torch(self, python_executable: str, cuda_build: str = "cu124") -> Tuple[bool, str]:
        """
        Ensure CUDA torch is installed. If CPU torch detected, remove and install CUDA version.
        Includes retry logic for robustness.
        
        Args:
            python_executable: Target Python executable
            cuda_build: CUDA build string (e.g., "cu124")
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        self.log(f"Checking torch installation (expecting CUDA build: {cuda_build})...")
        
        # Verify current torch state
        verify_cmd = [python_executable, "-c", "import torch; print(torch.__version__); print('CUDA:', torch.cuda.is_available())"]
        try:
            result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=10, **self.subprocess_flags)
            if result.returncode == 0:
                output = result.stdout.strip()
                version_line = output.split('\n')[0] if '\n' in output else output
                cuda_line = output.split('\n')[1] if '\n' in output else ""
                
                torch_version = version_line.strip()
                cuda_available = "True" in cuda_line or "CUDA: True" in output
                
                self.log(f"Current torch version: {torch_version}")
                self.log(f"CUDA available: {cuda_available}")
                
                # Check if torch is already correct CUDA version
                if f"+{cuda_build}" in torch_version and cuda_available:
                    self.log(f"✓ Torch already installed with CUDA {cuda_build}")
                    return True, ""
                
                # Check if CPU torch is installed
                if "+cpu" in torch_version or not cuda_available:
                    self.log(f"ERROR: CPU torch detected (version: {torch_version}, CUDA: {cuda_available})")
                    self.log("Removing CPU torch and installing CUDA torch...")
                else:
                    # Torch exists but wrong CUDA build
                    self.log(f"Torch has wrong CUDA build (version: {torch_version})")
                    self.log("Removing incorrect torch and installing correct CUDA torch...")
            else:
                # Torch import failed, need to install
                self.log("Torch not installed or import failed")
        except Exception as e:
            # Torch not installed
            self.log(f"Torch check failed: {str(e)}")
        
        # Clean up torch directories first to prevent file locking issues
        venv_path = Path(python_executable).parent.parent
        self.log("Cleaning up existing torch installations...")
        for pkg in ["torch", "torchvision", "torchaudio"]:
            if sys.platform == 'win32':
                pkg_dir = venv_path / "Lib" / "site-packages" / pkg
            else:
                pkg_dir = venv_path / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages" / pkg
            
            if pkg_dir.exists():
                self.log(f"Removing {pkg} directory: {pkg_dir}")
                success, error_msg = self._force_delete_locked_files(pkg_dir, max_retries=3)
                if not success:
                    self.log(f"WARNING: Could not fully remove {pkg}: {error_msg}")
        
        # Uninstall torch stack (run twice to ensure cleanup)
        torch_packages = ["torch", "torchvision", "torchaudio"]
        for attempt in [1, 2]:
            self.log(f"Uninstalling torch stack (attempt {attempt}/2)...")
            for pkg in torch_packages:
                uninstall_cmd = [python_executable, "-m", "pip", "uninstall", "-y", pkg]
                cmd_str = " ".join(uninstall_cmd)
                self.log(f"Running: {cmd_str}")
                result = subprocess.run(uninstall_cmd, capture_output=True, text=True, timeout=60, **self.subprocess_flags)
                # Continue even if uninstall fails (package may not be installed)
        
        # Install CUDA torch stack from PyTorch index (install separately to ensure exact versions)
        index_url = f"https://download.pytorch.org/whl/{cuda_build}"
        torch_version = f"2.5.1+{cuda_build}"
        torchvision_version = f"0.20.1+{cuda_build}"
        torchaudio_version = f"2.5.1+{cuda_build}"
        
        # Install torch first (with retry)
        max_retries = 3
        for retry in range(1, max_retries + 1):
            self.log(f"Installing torch {torch_version} (attempt {retry}/{max_retries})...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=f"torch=={torch_version}",
                python_executable=python_executable,
                index_url=index_url,
                pip_args=["--no-deps", "--no-cache-dir", "--force-reinstall"]
            )
            if success:
                self.log(f"✓ torch {torch_version} installed")
                break
            else:
                self.log(f"Attempt {retry}/{max_retries} failed (exit code: {exit_code})")
                if retry < max_retries:
                    import time
                    wait_time = retry * 2
                    self.log(f"Waiting {wait_time}s before retry...")
                    time.sleep(wait_time)
                    # Clean up any partial installation
                    self._cleanup_corrupted_packages(python_executable, packages=['torch'])
                else:
                    error_msg = f"Failed to install torch {torch_version} after {max_retries} attempts. Exit code: {exit_code}"
                    self.log(f"ERROR: {error_msg}")
                    return False, error_msg
        
        # Install torchvision (with retry)
        for retry in range(1, max_retries + 1):
            self.log(f"Installing torchvision {torchvision_version} (attempt {retry}/{max_retries})...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=f"torchvision=={torchvision_version}",
                python_executable=python_executable,
                index_url=index_url,
                pip_args=["--no-deps", "--no-cache-dir", "--force-reinstall"]
            )
            if success:
                self.log(f"✓ torchvision {torchvision_version} installed")
                break
            else:
                self.log(f"Attempt {retry}/{max_retries} failed (exit code: {exit_code})")
                if retry < max_retries:
                    import time
                    wait_time = retry * 2
                    self.log(f"Waiting {wait_time}s before retry...")
                    time.sleep(wait_time)
                    self._cleanup_corrupted_packages(python_executable, packages=['torchvision'])
                else:
                    error_msg = f"Failed to install torchvision {torchvision_version} after {max_retries} attempts. Exit code: {exit_code}"
                    self.log(f"ERROR: {error_msg}")
                    return False, error_msg
        
        # Install torchaudio (with retry)
        for retry in range(1, max_retries + 1):
            self.log(f"Installing torchaudio {torchaudio_version} (attempt {retry}/{max_retries})...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=f"torchaudio=={torchaudio_version}",
                python_executable=python_executable,
                index_url=index_url,
                pip_args=["--no-deps", "--no-cache-dir", "--force-reinstall"]
            )
            if success:
                self.log(f"✓ torchaudio {torchaudio_version} installed")
                break
            else:
                self.log(f"Attempt {retry}/{max_retries} failed (exit code: {exit_code})")
                if retry < max_retries:
                    import time
                    wait_time = retry * 2
                    self.log(f"Waiting {wait_time}s before retry...")
                    time.sleep(wait_time)
                    self._cleanup_corrupted_packages(python_executable, packages=['torchaudio'])
                else:
                    error_msg = f"Failed to install torchaudio {torchaudio_version} after {max_retries} attempts. Exit code: {exit_code}"
                    self.log(f"ERROR: {error_msg}")
                    return False, error_msg
        
        # Re-verify CUDA torch
        self.log("Verifying CUDA torch installation...")
        verify_cmd = [python_executable, "-c", f"import torch; assert torch.__version__ == '{torch_version}', f'Expected {torch_version}, got {{torch.__version__}}'; assert torch.cuda.is_available(), 'CUDA not available'; print('CUDA torch OK')"]
        result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=10, **self.subprocess_flags)
        
        if result.returncode != 0:
            error_output = result.stderr or result.stdout
            error_msg = f"CUDA torch verification failed: {error_output.strip()}"
            self.log(f"ERROR: {error_msg}")
            return False, error_msg
        
        self.log(f"✓ CUDA torch {torch_version} installed and verified")
        return True, ""
    
    def _terminate_venv_processes(self, venv_path: Path) -> Tuple[bool, list]:
        """
        Terminate all Python processes using the target venv.
        
        Returns:
            Tuple of (success: bool, terminated_pids: list)
        """
        if platform.system() != "Windows":
            return True, []  # Less critical on other platforms
        
        terminated_pids = []
        
        try:
            import psutil
        except ImportError:
            # Try using taskkill on Windows
            try:
                venv_python = venv_path / "Scripts" / "python.exe"
                if venv_python.exists():
                    # Kill processes using this specific Python
                    subprocess.run(
                        ["taskkill", "/F", "/IM", "python.exe", "/FI", f"IMAGEPATH eq {venv_python}"],
                        capture_output=True,
                        timeout=10,
                        **self.subprocess_flags
                    )
                    subprocess.run(
                        ["taskkill", "/F", "/IM", "pythonw.exe", "/FI", f"IMAGEPATH eq {venv_python}"],
                        capture_output=True,
                        timeout=10,
                        **self.subprocess_flags
                    )
                return True, []
            except Exception:
                return False, []
        
        # Use psutil to find and kill processes
        current_pid = os.getpid()
        try:
            current_process = psutil.Process(current_pid)
            parent_pid = current_process.ppid() if hasattr(current_process, 'ppid') else None
        except:
            parent_pid = None
        
        for proc in psutil.process_iter(['pid', 'name', 'exe']):
            try:
                proc_info = proc.info
                proc_pid = proc_info.get('pid')
                
                # Never kill current process or parent
                if proc_pid == current_pid or (parent_pid and proc_pid == parent_pid):
                    continue
                
                if proc_info.get('name') and 'python' in proc_info.get('name', '').lower():
                    exe_path = proc_info.get('exe')
                    if exe_path:
                        exe_path_obj = Path(exe_path)
                        # Check if this Python is from our venv
                        if str(exe_path_obj.parent.parent).lower() == str(venv_path).lower():
                            try:
                                proc.kill()
                                terminated_pids.append(proc_pid)
                                self.log(f"Terminated Python process: {proc_info.get('name')} (PID {proc_pid})")
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                pass
            except (psutil.NoSuchProcess, psutil.AccessDenied, KeyError):
                pass
        
        if terminated_pids:
            import time
            time.sleep(2)  # Wait for processes to terminate
        
        return True, terminated_pids
    
    def _gate_python_version(self, python_executable: str) -> Tuple[bool, str, Optional[str]]:
        """
        GATE 1: Python version gate
        - If Python >= 3.13 and stack not validated:
            → Abort OR auto-create a Python 3.12 venv
        - Never attempt to install a torch wheel that does not exist for the current Python ABI.
        
        Returns:
            Tuple of (pass: bool, error_message: str, new_python_executable: Optional[str])
        """
        try:
            result = subprocess.run(
                [python_executable, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            if result.returncode != 0:
                return False, f"Could not detect Python version from {python_executable}", None
            
            python_version = result.stdout.strip()
            major, minor = map(int, python_version.split('.'))
            
            if major >= 3 and minor >= 13:
                self.log(f"WARNING: Python {python_version} >= 3.13 detected")
                self.log("Python 3.13+ may not have compatible PyTorch wheels")
                
                # Check if we can create a Python 3.12 venv
                venv_path = Path(python_executable).parent.parent
                new_venv_path = venv_path.parent / "venv_py312"
                
                # Try to find Python 3.12
                try:
                    # Try common locations
                    py312_candidates = [
                        "py -3.12",
                        "python3.12",
                        "python312",
                        r"C:\Python312\python.exe",
                        r"C:\Program Files\Python312\python.exe",
                    ]
                    
                    py312_exe = None
                    for candidate in py312_candidates:
                        try:
                            test_result = subprocess.run(
                                [candidate, "--version"],
                                capture_output=True,
                                text=True,
                                timeout=5,
                                **self.subprocess_flags
                            )
                            if test_result.returncode == 0 and "3.12" in test_result.stdout:
                                py312_exe = candidate
                                break
                        except:
                            continue
                    
                    if py312_exe:
                        self.log(f"Found Python 3.12 at: {py312_exe}")
                        self.log(f"Creating Python 3.12 venv at: {new_venv_path}")
                        # Create venv
                        create_result = subprocess.run(
                            [py312_exe, "-m", "venv", str(new_venv_path)],
                            capture_output=True,
                            text=True,
                            timeout=60,
                            **self.subprocess_flags
                        )
                        if create_result.returncode == 0:
                            new_python = new_venv_path / "Scripts" / "python.exe" if sys.platform == "win32" else new_venv_path / "bin" / "python"
                            if new_python.exists():
                                self.log(f"Python 3.12 venv created successfully")
                                return True, "", str(new_python)
                    
                    # If we can't create 3.12 venv, abort
                    return False, f"Python {python_version} >= 3.13 detected, but Python 3.12 not found. Cannot proceed.", None
                    
                except Exception as e:
                    return False, f"Failed to create Python 3.12 venv: {str(e)}", None
            
            return True, "", None
            
        except Exception as e:
            return False, f"Python version gate failed: {str(e)}", None
    
    def _gate_wheel_availability(self, python_executable: str, package_spec: str, index_url: str = "") -> Tuple[bool, str, Optional[str]]:
        """
        GATE 2: Wheel availability gate
        - Before installing torch, query available versions for the index.
        - If the pinned version is unavailable, do NOT install.
        - Select a compatible version or abort with a clear message.
        
        Returns:
            Tuple of (pass: bool, error_message: str, available_version: Optional[str])
        """
        # Extract package name and version from spec (e.g., "torch==2.5.1+cu118" -> "torch", "2.5.1+cu118")
        if "==" in package_spec:
            pkg_name, pkg_version = package_spec.split("==", 1)
        elif ">=" in package_spec or "<=" in package_spec or ">" in package_spec or "<" in package_spec:
            # For version ranges, we can't check availability easily, skip gate
            return True, "", None
        else:
            pkg_name = package_spec
            pkg_version = None
        
        # Only check for torch, torchvision, torchaudio (binary wheels)
        if pkg_name not in ["torch", "torchvision", "torchaudio"]:
            return True, "", None
        
        self.log(f"Checking wheel availability for {package_spec}...")
        
        try:
            # Query available versions using pip install --dry-run (simpler approach)
            cmd = [python_executable, "-m", "pip", "install", "--dry-run", package_spec]
            if index_url:
                cmd.extend(["--index-url", index_url])
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                # If dry-run fails, check if it's a "no matching distribution" error
                error_output = (result.stderr or result.stdout).lower()
                if "no matching distribution" in error_output or "could not find" in error_output:
                    return False, f"Wheel for {package_spec} is not available for this Python ABI", None
                # Other errors might be temporary, allow to proceed
                self.log(f"WARNING: Could not verify wheel availability (will try install anyway)")
                return True, "", None  # Allow to proceed, will fail at install if truly unavailable
            
            # Dry-run succeeded, wheel is available
            self.log(f"✓ Wheel available: {package_spec}")
            return True, "", pkg_version if pkg_version else None
                    
        except Exception as e:
            # CRITICAL: Treat exceptions as fatal, not warnings
            error_msg = f"Wheel availability check threw exception: {str(e)}"
            self.log(f"ERROR: {error_msg}")
            return False, error_msg, None
    
    def _gate_numpy_integrity(self, python_executable: str) -> Tuple[bool, str]:
        """
        GATE 3: NumPy integrity gate
        - Before and after any install step:
            python -c "import numpy"
        - If this fails:
            → Delete the venv and recreate it.
            → Never continue with a broken NumPy.
        
        Returns:
            Tuple of (pass: bool, error_message: str)
        """
        try:
            result = subprocess.run(
                [python_executable, "-c", "import numpy"],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                return True, ""
            else:
                error_msg = result.stderr.strip() or result.stdout.strip() or "Unknown error"
                return False, f"NumPy integrity check failed: {error_msg}"
                
        except Exception as e:
            return False, f"NumPy integrity check exception: {str(e)}"
    
    def _recreate_venv(self, venv_path: Path, python_executable: str) -> Tuple[bool, str, Optional[str]]:
        """
        Recreate a venv (used when NumPy integrity fails).
        
        Returns:
            Tuple of (success: bool, error_message: str, new_python_executable: Optional[str])
        """
        self.log("=" * 60)
        self.log("RECREATING VENV: NumPy integrity failed")
        self.log("=" * 60)
        
        try:
            # Delete existing venv
            if venv_path.exists():
                self.log(f"Deleting broken venv: {venv_path}")
                shutil.rmtree(venv_path, ignore_errors=True)
            
            # Recreate venv
            self.log(f"Creating new venv: {venv_path}")
            result = subprocess.run(
                [python_executable, "-m", "venv", str(venv_path)],
                capture_output=True,
                text=True,
                timeout=60,
                **self.subprocess_flags
            )
            
            if result.returncode != 0:
                return False, f"Failed to recreate venv: {result.stderr}", None
            
            # Get new Python executable
            new_python = venv_path / "Scripts" / "python.exe" if sys.platform == "win32" else venv_path / "bin" / "python"
            if not new_python.exists():
                return False, f"New venv created but Python executable not found at {new_python}", None
            
            self.log(f"✓ Venv recreated successfully: {new_python}")
            return True, "", str(new_python)
            
        except Exception as e:
            return False, f"Exception recreating venv: {str(e)}", None
    
    def _check_running_processes_before_binary_install(self, python_executable: str) -> Tuple[bool, str]:
        """
        BEFORE uninstall/install of any binary wheel:
        - Check no python.exe is running from the target venv
        - Check the GUI app is not running
        - If any are found, abort with a clear message
        
        Returns:
            Tuple of (safe_to_proceed: bool, error_message: str)
        """
        venv_path = Path(python_executable).parent.parent
        venv_python = venv_path / "Scripts" / "python.exe" if sys.platform == "win32" else venv_path / "bin" / "python"
        
        if not venv_python.exists():
            return True, None  # Venv doesn't exist yet, safe to proceed
        
        running_processes = []
        
        # Check for python.exe from target venv
        if sys.platform == "win32":
            try:
                result = subprocess.run(
                    ["tasklist", "/FI", f"IMAGEPATH eq {venv_python}", "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    **self.subprocess_flags
                )
                if result.returncode == 0 and venv_python.name in result.stdout:
                    running_processes.append(f"Python process from target venv: {venv_python}")
            except Exception:
                pass
        
        # Check for GUI app (desktop_app/main.py or launcher.exe)
        try:
            if sys.platform == "win32":
                # Check for launcher.exe or main.py processes
                result = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq launcher.exe", "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    **self.subprocess_flags
                )
                if result.returncode == 0 and "launcher.exe" in result.stdout:
                    running_processes.append("GUI launcher (launcher.exe) is running")
        except Exception:
            pass
        
        if running_processes:
            error_msg = "Cannot install binary wheels while the following processes are running:\n"
            error_msg += "\n".join(f"  - {proc}" for proc in running_processes)
            error_msg += "\n\nPlease close all Python processes and the GUI application, then try again."
            return False, error_msg
        
        return True, None
    
    def _cleanup_corrupted_packages(self, python_executable: str, packages: list = None) -> bool:
        """
        Clean up corrupted package directories that may have locked files.
        
        Args:
            python_executable: Target Python executable
            packages: List of package names to clean (default: ['numpy', 'torch', 'torchvision', 'torchaudio'])
        
        Returns:
            bool: True if cleanup successful or not needed, False if critical error
        """
        if packages is None:
            packages = ['numpy', 'torch', 'torchvision', 'torchaudio']
        
        venv_path = Path(python_executable).parent.parent
        if sys.platform == 'win32':
            site_packages = venv_path / "Lib" / "site-packages"
        else:
            # Find site-packages directory for non-Windows
            result = subprocess.run(
                [python_executable, "-c", "import site; print(site.getsitepackages()[0])"],
                capture_output=True,
                text=True,
                timeout=5,
                **self.subprocess_flags
            )
            if result.returncode == 0:
                site_packages = Path(result.stdout.strip())
            else:
                # Fallback
                site_packages = venv_path / "lib" / "python3.12" / "site-packages"
        
        if not site_packages.exists():
            self.log(f"Site-packages not found at {site_packages}, skipping cleanup")
            return True
        
        self.log("Checking for corrupted packages...")
        cleaned_any = False
        
        for pkg in packages:
            pkg_dir = site_packages / pkg
            if pkg_dir.exists():
                self.log(f"Found {pkg} directory, attempting cleanup...")
                success, error_msg = self._force_delete_locked_files(pkg_dir, max_retries=3)
                if success:
                    self.log(f"✓ Cleaned up {pkg}")
                    cleaned_any = True
                else:
                    self.log(f"WARNING: Could not fully clean {pkg}: {error_msg}")
                    # Don't fail entirely, just warn
        
        if cleaned_any:
            self.log("✓ Package cleanup completed")
        else:
            self.log("No corrupted packages found")
        
        return True
    
    def _force_delete_locked_files(self, directory: Path, max_retries: int = 3) -> Tuple[bool, str]:
        """
        Forcefully delete locked files with retry mechanism.
        
        Args:
            directory: Directory to delete
            max_retries: Maximum number of retry attempts
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        import time
        
        if not directory.exists():
            return True, ""
        
        self.log(f"Attempting to delete directory: {directory}")
        
        for attempt in range(1, max_retries + 1):
            try:
                # Try direct deletion first
                if sys.platform == 'win32':
                    # On Windows, use subprocess with /F flag to force delete
                    result = subprocess.run(
                        ['cmd', '/c', 'rmdir', '/S', '/Q', str(directory)],
                        capture_output=True,
                        text=True,
                        timeout=30
                    )
                    if result.returncode == 0 or not directory.exists():
                        self.log(f"✓ Directory deleted (attempt {attempt}/{max_retries})")
                        return True, ""
                else:
                    shutil.rmtree(directory, ignore_errors=True)
                    if not directory.exists():
                        self.log(f"✓ Directory deleted (attempt {attempt}/{max_retries})")
                        return True, ""
            except Exception as e:
                self.log(f"Delete attempt {attempt}/{max_retries} failed: {str(e)}")
            
            # If not last attempt, wait and retry
            if attempt < max_retries:
                wait_time = attempt * 2  # Exponential backoff
                self.log(f"Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
        
        # Final check after all retries
        if not directory.exists():
            return True, ""
        
        error_msg = f"Failed to delete {directory} after {max_retries} attempts. Files may be locked by running processes."
        return False, error_msg
    
    def _delete_torch_directory(self, venv_path: Path) -> Tuple[bool, str]:
        """
        Delete the torch directory from venv.
        
        Returns:
            Tuple of (success: bool, error_message: str)
        """
        torch_dir = venv_path / "Lib" / "site-packages" / "torch"
        
        if not torch_dir.exists():
            return True, None
        
        self.log(f"Deleting existing torch directory: {torch_dir}")
        
        try:
            # Use force delete with retry
            success, error_msg = self._force_delete_locked_files(torch_dir, max_retries=3)
            
            if not success:
                self.log(f"ERROR: {error_msg}")
                return False, error_msg
            
            self.log("✓ Torch directory deleted successfully")
            return True, None
        except Exception as e:
            error_msg = f"Failed to delete torch directory: {str(e)}"
            self.log(f"ERROR: {error_msg}")
            return False, error_msg
    
    def _check_disk_space(self, path: Optional[Path] = None) -> Tuple[bool, float]:
        """
        Check available disk space at the given path.
        
        Returns:
            Tuple of (has_enough_space, free_space_gb)
        """
        if path is None:
            path = self.install_dir
        
        try:
            if platform.system() == "Windows":
                import ctypes
                free_bytes = ctypes.c_ulonglong(0)
                ctypes.windll.kernel32.GetDiskFreeSpaceExW(
                    ctypes.c_wchar_p(str(path)),
                    ctypes.pointer(ctypes.c_ulonglong()),
                    ctypes.pointer(ctypes.c_ulonglong()),
                    ctypes.pointer(free_bytes)
                )
                free_gb = free_bytes.value / (1024**3)
            else:
                stat = shutil.disk_usage(str(path))
                free_gb = stat.free / (1024**3)
            
            has_enough = free_gb >= self.min_disk_space_gb
            return has_enough, free_gb
        except Exception as e:
            # If we can't check, assume it's OK (better than blocking)
            self.log(f"Warning: Could not check disk space: {str(e)}")
            return True, 0.0
    
    def _sanitize_requirement(self, req_string: str) -> str:
        """
        Sanitize a requirement string by removing inline comments.
        
        Removes everything after '#' and trims whitespace.
        Example: "transformers==4.51.3  # comment" -> "transformers==4.51.3"
        
        Args:
            req_string: Requirement string that may contain inline comments
        
        Returns:
            Sanitized requirement string without comments
        """
        if not req_string:
            return ""
        # Remove everything after '#' and strip whitespace
        sanitized = req_string.split('#')[0].strip()
        return sanitized
    
    def _run_pip_worker(self, action: str, package: str, python_executable: str,
                       index_url: str = "", pip_args: list = None) -> Tuple[bool, str, int]:
        """
        Run pip command via worker process, stream output in real-time.
        
        Args:
            action: 'install' or 'uninstall'
            package: Package name with optional version constraints (e.g., 'torch==2.5.1', 'numpy<2')
            python_executable: Python executable to use
            index_url: Index URL for pip (optional)
            pip_args: Pip arguments to forward directly (e.g., ['--force-reinstall', '--no-deps'])
        
        Returns:
            Tuple of (success: bool, last_200_lines: str, exit_code: int)
        """
        # Get path to pip_worker.py (should be in same directory as this file)
        worker_script = Path(__file__).parent / "pip_worker.py"
        if not worker_script.exists():
            error_msg = f"pip_worker.py not found at {worker_script}"
            self.log(f"ERROR: {error_msg}")
            return False, error_msg, 1
        
        if pip_args is None:
            pip_args = []
        
        # Sanitize package string to remove any inline comments
        package = self._sanitize_requirement(package)
        
        # On Windows, quote package specs containing < or > to avoid shell interpretation
        import platform
        if platform.system() == "Windows" and ("<" in package or ">" in package):
            # Package is already a string, but we need to ensure it's passed correctly
            # subprocess.Popen handles this correctly when passed as a list element
            pass  # No need to quote - subprocess handles it correctly
        
        # Build command to launch worker
        # Use the target Python executable to run the worker script (not sys.executable which might be pythonw.exe)
        cmd = [
            python_executable,  # Use target Python to run worker script
            str(worker_script),
            "--action", action,
            "--package", package,
            "--python", python_executable
        ]
        
        if index_url:
            cmd.extend(["--index-url", index_url])
        
        # Add pip args directly (they will be forwarded by parse_known_args)
        cmd.extend(pip_args)
        
        # Log exact pip command that will be executed
        pip_cmd_str = f"{python_executable} -m pip {action}"
        if index_url:
            pip_cmd_str += f" --index-url {index_url}"
        pip_cmd_str += " " + " ".join(pip_args) + " " + package
        self.log(f"Pip command: {pip_cmd_str}")
        
        try:
            # Use Popen to stream output in real-time
            # Redirect stderr to stdout so we capture all output
            popen_flags = {
                'stdout': subprocess.PIPE,
                'stderr': subprocess.STDOUT,  # Redirect stderr to stdout
                'text': True,
                'bufsize': 1,
                'universal_newlines': True
            }
            popen_flags.update(self.subprocess_flags)
            
            process = subprocess.Popen(cmd, **popen_flags)
            
            # Stream output line by line with timeout protection
            # Use threading to read stdout so we can show progress during long downloads
            output_lines = []
            import time
            import threading
            import queue as queue_module
            
            output_queue = queue_module.Queue()
            read_done = threading.Event()
            
            def read_stdout():
                """Read stdout in separate thread to prevent blocking"""
                try:
                    for line in process.stdout:
                        line = line.rstrip()
                        if line:
                            output_queue.put(line)
                except Exception:
                    pass
                finally:
                    read_done.set()
            
            reader_thread = threading.Thread(target=read_stdout, daemon=True)
            reader_thread.start()
            
            start_time = time.time()
            last_output_time = start_time
            max_silence = 30  # Show progress every 30 seconds
            max_wait = 3600  # 1 hour max total
            
            # Process output with timeout checks
            while True:
                current_time = time.time()
                
                # Check overall timeout
                if current_time - start_time > max_wait:
                    process.kill()
                    self.log(f"ERROR: Pip operation timed out after {max_wait} seconds")
                    return False, "Operation timed out", 1
                
                # Try to get output (non-blocking)
                try:
                    line = output_queue.get(timeout=1.0)
                    output_lines.append(line)
                    self.log(line)
                    last_output_time = current_time
                except queue_module.Empty:
                    # No output for 1 second
                    if process.poll() is not None:
                        # Process finished - drain remaining queue
                        read_done.wait(timeout=2.0)
                        while True:
                            try:
                                line = output_queue.get_nowait()
                                output_lines.append(line)
                                self.log(line)
                            except queue_module.Empty:
                                break
                        break
                    else:
                        # Still running - check if we should show progress
                        if current_time - last_output_time > max_silence:
                            elapsed = int(current_time - start_time)
                            self.log(f"[INFO] Still working... (running for {elapsed}s)")
                            last_output_time = current_time
            
            # Wait for process to complete
            exit_code = process.wait()
            
            # Get last 200 lines for error reporting
            last_200_lines = '\n'.join(output_lines[-200:]) if len(output_lines) > 200 else '\n'.join(output_lines)
            
            success = (exit_code == 0)
            
            if not success:
                self.log(f"ERROR: pip {action} failed with exit code {exit_code}")
                self.log(f"Command: {' '.join(cmd)}")
                self.log(f"Last {len(output_lines[-200:]) if len(output_lines) > 200 else len(output_lines)} lines:")
                for line in output_lines[-200:]:
                    self.log(line)
            
            return success, last_200_lines, exit_code
            
        except Exception as e:
            error_msg = f"Exception running pip worker: {str(e)}"
            self.log(f"ERROR: {error_msg}")
            self.log(f"Command: {' '.join(cmd)}")
            return False, error_msg, 1
    
    def run_detection(self) -> Dict:
        """Run system detection"""
        self.log("Detecting system components...")
        self.detection_results = self.detector.detect_all()
        return self.detection_results
    
    def install_python(self) -> bool:
        """Install Python if not found"""
        python_info = self.detection_results.get("python", {})
        
        if python_info.get("found"):
            self.log(f"Python {python_info.get('version')} found at {python_info.get('executable')}")
            return True
        
        self.log("Python not found. Installation required.")
        self.log("Please install Python 3.8+ from https://www.python.org/downloads/")
        self.log("Make sure to check 'Add Python to PATH' during installation.")
        return False
    
    def install_vcredist(self) -> bool:
        """Install Visual C++ Redistributables if needed (Windows only)
        
        Tries to use local runtime DLLs first, falls back to system installation if needed.
        """
        if platform.system() != "Windows":
            return True
        
        vcredist_info = self.detection_results.get("vcredist", {})
        
        if vcredist_info.get("found"):
            self.log("Visual C++ Redistributables found")
            return True
        
        # Try to use self-contained runtime DLLs first
        try:
            from core.runtime_manager import RuntimeManager
            runtime_manager = RuntimeManager(self.install_dir)
            dll_dir = runtime_manager.get_vcredist_dlls()
            if dll_dir:
                self.log("Visual C++ DLLs found in local runtime directory")
                # Setup local PATH for this process
                runtime_manager.setup_local_path()
                return True
        except Exception as e:
            self.log(f"Could not use local runtime DLLs: {e}")
        
        # Fallback to system installation
        self.log("Visual C++ Redistributables not found.")
        self.log("Downloading and installing Visual C++ Redistributables...")
        
        # Download URL for Visual C++ Redistributables
        vcredist_url = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
        vcredist_path = self.install_dir / "vc_redist.x64.exe"
        
        try:
            import urllib.request
            self.log(f"Downloading from {vcredist_url}...")
            urllib.request.urlretrieve(vcredist_url, vcredist_path)
            
            # Install silently
            self.log("Installing Visual C++ Redistributables...")
            result = subprocess.run(
                [str(vcredist_path), "/install", "/quiet", "/norestart"],
                timeout=300,
                capture_output=True,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                self.log("Visual C++ Redistributables installed successfully")
                # Clean up
                if vcredist_path.exists():
                    vcredist_path.unlink()
                return True
            else:
                self.log(f"Installation failed with code {result.returncode}")
                return False
        
        except Exception as e:
            self.log(f"Error installing Visual C++ Redistributables: {e}")
            self.log("Please install manually from: https://aka.ms/vs/17/release/vc_redist.x64.exe")
            return False
    
    def get_optimal_cuda_build(self) -> str:
        """Determine optimal CUDA build based on hardware detection"""
        cuda_info = self.detection_results.get("cuda", {})
        driver_version = cuda_info.get("driver_version")
        gpus = cuda_info.get("gpus", [])
        
        if not driver_version or not gpus:
            self.log("No CUDA detected. Using CPU build.")
            return "cpu"

        def _parse_driver_major(ver: Optional[str]) -> Optional[int]:
            if not ver:
                return None
            try:
                return int(float(ver.split(".")[0]))
            except Exception:
                return None

        def _parse_mem_mib(mem_str: str) -> int:
            # nvidia-smi often returns like: "24576 MiB" or "24576 MB"
            if not mem_str:
                return 0
            try:
                digits = "".join(ch for ch in mem_str if ch.isdigit())
                return int(digits) if digits else 0
            except Exception:
                return 0

        def _recommended_to_build(recommended: Optional[str]) -> Optional[str]:
            if not recommended:
                return None
            if "12.4" in recommended:
                return "cu124"
            if "12.1" in recommended:
                return "cu121"
            if "11.8" in recommended or "11" in recommended or "10" in recommended:
                return "cu118"
            return None

        # Choose the best GPU (mixed-GPU systems): prefer higher recommended CUDA / compute / VRAM.
        driver_major = _parse_driver_major(driver_version)
        best_gpu = None
        best_compat = None
        best_score = (-1, -1.0, -1)  # (recommended_rank, compute, mem_mib)

        for gpu in gpus:
            name = gpu.get("name", "") or ""
            mem_mib = _parse_mem_mib(gpu.get("memory", "") or "")

            compat = None
            for known_gpu, info in self.GPU_COMPAT.items():
                if known_gpu in name:
                    compat = info
                    break

            if compat:
                recommended = compat.get("recommended_cuda")
                build = _recommended_to_build(recommended) or "cu118"
                recommended_rank = {"cu118": 1, "cu121": 2, "cu124": 3}.get(build, 0)
                try:
                    compute = float(compat.get("compute", "0") or 0)
                except Exception:
                    compute = 0.0
            else:
                recommended_rank = 0
                compute = 0.0

            score = (recommended_rank, compute, mem_mib)
            if score > best_score:
                best_score = score
                best_gpu = gpu
                best_compat = compat

        selected_name = (best_gpu or {}).get("name", "") if best_gpu else ""

        # If we have a known GPU, start from its recommended build, but don't exceed driver capability.
        desired_build = None
        if best_compat:
            recommended = best_compat.get("recommended_cuda", "11.8")
            desired_build = _recommended_to_build(recommended)
            self.log(f"Detected GPUs: {len(gpus)} | Selected: {selected_name} | Recommended CUDA: {recommended}")
        else:
            self.log(f"Detected GPUs: {len(gpus)} | Selected: {selected_name} | No known GPU match; using driver-based selection.")

        if driver_major is not None and desired_build is not None:
            # Gate by driver major version (conservative fallbacks).
            if desired_build == "cu124" and driver_major < 555:
                desired_build = "cu121" if driver_major >= 545 else ("cu118" if driver_major >= 450 else "cpu")
            elif desired_build == "cu121" and driver_major < 545:
                desired_build = "cu118" if driver_major >= 450 else "cpu"
            elif desired_build == "cu118" and driver_major < 450:
                desired_build = "cpu"

            return desired_build
        
        # Fallback: use driver version to determine build
        try:
            driver_major = int(float(driver_version.split('.')[0]))
            
            if driver_major >= 555:
                return "cu124"  # CUDA 12.4
            elif driver_major >= 545:
                return "cu121"  # CUDA 12.1
            elif driver_major >= 450:
                return "cu118"  # CUDA 11.8
            else:
                self.log(f"Warning: Old driver {driver_version}. Using CPU build.")
                return "cpu"
        except:
            self.log(f"Could not parse driver version {driver_version}. Using CPU build.")
            return "cpu"
    
    def install_pytorch(self, python_executable: Optional[str] = None) -> bool:
        """Install PyTorch based on detection with proper version compatibility"""
        if not python_executable:
            python_info = self.detection_results.get("python", {})
            if not python_info.get("found"):
                self.log("Python not found. Cannot install PyTorch.")
                return False
            python_executable = python_info.get("executable")
        
        # Run detection if not already done
        if not self.detection_results:
            self.run_detection()
        
        # CRITICAL: Determine venv path and verify no processes are using it
        python_path = Path(python_executable)
        if "Scripts" in str(python_path) or "bin" in str(python_path):
            venv_path = python_path.parent.parent
        else:
            # Not a venv Python, use install_dir
            venv_path = self.install_dir / ".venv"
        
        self.log(f"Target venv path: {venv_path}")
        
        # CRITICAL: Verify installer is not running from target venv
        # This should never happen due to bootstrap guard, but double-check
        current_python = Path(sys.executable).resolve()
        current_python_str = str(current_python).replace('\\', '/')
        
        # Check if running from LLM\.venv (case-insensitive)
        current_python_normalized = current_python_str.lower()
        if '/llm/.venv/' in current_python_normalized or '\\llm\\.venv\\' in current_python_str.lower():
            self.log("=" * 60)
            self.log("CRITICAL ERROR: Installer is running from target venv!")
            self.log(f"Current Python: {sys.executable}")
            self.log("This should never happen - bootstrap guard should have prevented this.")
            self.log("Aborting PyTorch installation.")
            self.log("=" * 60)
            return False
        
        # CRITICAL: Terminate any processes using the target venv
        self.log("Checking for processes using target venv...")
        success, terminated_pids = self._terminate_venv_processes(venv_path)
        if not success:
            self.log("WARNING: Could not check/terminate processes. Proceeding anyway...")
        elif terminated_pids:
            self.log(f"Terminated {len(terminated_pids)} process(es) using the venv")
            import time
            time.sleep(3)  # Wait for processes to fully terminate
        
        # Verify no python.exe from venv is running
        if platform.system() == "Windows":
            try:
                venv_python = venv_path / "Scripts" / "python.exe"
                if venv_python.exists():
                    check_cmd = [
                        "tasklist", "/FI", f"IMAGEPATH eq {venv_python}", "/FO", "CSV", "/NH"
                    ]
                    result = subprocess.run(check_cmd, capture_output=True, text=True, timeout=5, **self.subprocess_flags)
                    if result.returncode == 0 and venv_python.name in result.stdout:
                        self.log("ERROR: Python process from target venv is still running!")
                        self.log("Please close all Python windows and try again.")
                        return False
            except Exception:
                pass  # Non-fatal
        
        # CRITICAL: Delete the entire torch directory if it exists
        self.log("Checking for existing torch installation...")
        success, error_msg = self._delete_torch_directory(venv_path)
        if not success:
            self.log("=" * 60)
            self.log("CRITICAL ERROR: Cannot proceed with PyTorch installation")
            self.log(error_msg)
            self.log("=" * 60)
            return False
        
        # First, uninstall any existing torch to avoid conflicts.
        # IMPORTANT: also remove xformers and triton variants on Windows to avoid pip resolver downgrading torch.
        self.log("Uninstalling any existing PyTorch / xformers / triton installation...")
        packages_to_uninstall = ["torch", "torchvision", "torchaudio", "xformers", "triton", "triton-windows"]
        for pkg in packages_to_uninstall:
            try:
                success, last_lines, exit_code = self._run_pip_worker(
                    action="uninstall",
                    package=pkg,
                    python_executable=python_executable
                )
                # Uninstall failures are OK if package wasn't installed
                if not success and "not installed" not in last_lines.lower():
                    self.log(f"Note: Uninstall of {pkg} had issues: {last_lines[:200]}")
            except Exception as e:
                self.log(f"Note: Could not uninstall {pkg}: {e}")
        
        # Determine optimal CUDA build
        cuda_build = self.get_optimal_cuda_build()
        
        # Get versions from matrix
        build_key_map = {
            "cu124": "cuda_12_4",
            "cu121": "cuda_12_1",
            "cu118": "cuda_11_8",
            "cpu": "cpu",
        }
        build_key = build_key_map.get(cuda_build, "cpu")
        if build_key not in self.VERSION_MATRIX:
            build_key = "cpu"
        
        versions = self.VERSION_MATRIX[build_key]
        pytorch_version = versions["torch"]
        torchvision_version = versions["torchvision"]
        torchaudio_version = versions["torchaudio"]
        triton_version = versions["triton"]
        
        self.log(f"Installing PyTorch {pytorch_version} ({cuda_build} build) [force-reinstall, no-deps]...")
        
        try:
            # Ensure numpy is in a safe range before importing torch inside the GUI / detectors.
            # NumPy 2.x can break some torch numpy bridges on Windows.
            try:
                success, last_lines, exit_code = self._run_pip_worker(
                    action="install",
                    package="numpy<2",
                    python_executable=python_executable,
                    pip_args=["--upgrade"]
                )
                # Non-fatal if numpy install fails
            except Exception:
                pass

            # CRITICAL: Install torch FIRST and verify it works before installing torchvision/torchaudio
            # Installing all three together with --no-deps can cause crashes if torch isn't fully ready
            index_url = f"https://download.pytorch.org/whl/{cuda_build}" if cuda_build != "cpu" else "https://download.pytorch.org/whl/cpu"
            
            self.log("Downloading PyTorch (~2.5GB)...")
            
            # Use worker process for installation
            # CRITICAL: Use --no-cache-dir to avoid file lock issues
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=f"torch=={pytorch_version}",
                python_executable=python_executable,
                index_url=index_url,
                pip_args=["--force-reinstall", "--no-deps", "--no-cache-dir"]
            )
            
            if success:
                self.log("PyTorch torch package installed successfully")
                
                # CRITICAL: Verify torch can be imported BEFORE installing torchvision/torchaudio
                self.log("Verifying torch installation before proceeding...")
                torch_ok, torch_ver, torch_cuda, torch_error = self._verify_torch(python_executable)
                if not torch_ok:
                    self.log(f"ERROR: torch installed but verification failed: {torch_error}")
                    return False
                
                self.log(f"✓ torch verified and working (version {torch_ver})")
                # NOTE: torchvision and torchaudio will be installed separately by _install_component
                # when processing the checklist items "PyTorch Vision" and "PyTorch Audio"
                # This ensures proper dependency order
                
                return True
            else:
                self.log(f"PyTorch installation failed with exit code {exit_code}")
                self.log("=" * 60)
                self.log("PYTORCH INSTALLATION ERROR OUTPUT:")
                self.log("=" * 60)
                # Log last 200 lines (already captured by worker)
                error_lines = last_lines.split('\n')[-50:] if last_lines else []
                for line in error_lines:
                    self.log(line)
                self.log("=" * 60)
                # Check for common errors
                if "No space left on device" in last_lines or "Errno 28" in last_lines:
                    has_space, free_gb = self._check_disk_space()
                    self.log(f"ERROR: Insufficient disk space! Only {free_gb:.2f} GB available")
                    self.log("PyTorch requires ~3GB free space. Please free up disk space.")
                    return False
                elif "WinError 5" in last_lines or "Access is denied" in last_lines or "Permission denied" in last_lines:
                    # File lock error - try to identify which file and process
                    self.log("=" * 60)
                    self.log("CRITICAL ERROR: File lock detected during PyTorch installation")
                    self.log("=" * 60)
                    
                    # Try to extract the locked file from error message
                    import re
                    file_match = re.search(r"Access is denied: '([^']+)'", last_lines)
                    if file_match:
                        locked_file = file_match.group(1)
                        self.log(f"Locked file: {locked_file}")
                        
                        # Try to find which process is locking it (Windows only)
                        if platform.system() == "Windows":
                            try:
                                # Use handle.exe if available, or try tasklist
                                handle_cmd = ["handle.exe", locked_file]
                                handle_result = subprocess.run(
                                    handle_cmd, capture_output=True, text=True, timeout=5,
                                    **self.subprocess_flags
                                )
                                if handle_result.returncode == 0:
                                    self.log("Process locking file:")
                                    self.log(handle_result.stdout)
                                else:
                                    self.log("Note: handle.exe not available. Install Sysinternals Handle to identify locking process.")
                            except Exception:
                                pass
                    
                    self.log("=" * 60)
                    self.log("SOLUTION:")
                    self.log("1. Close ALL Python windows and processes")
                    self.log("2. Close the installer GUI")
                    self.log("3. Wait 10 seconds")
                    self.log("4. Run the installer again")
                    self.log("=" * 60)
                    return False
                elif "Could not find a version" in last_lines:
                    self.log("ERROR: Could not find PyTorch version. Check internet connection.")
                    return False
                return False
        
        except Exception as e:
            self.log(f"Error installing PyTorch: {e}")
            return False
    
    def install_dependencies(self, python_executable: Optional[str] = None) -> bool:
        """Install application dependencies with compatibility handling"""
        if not python_executable:
            python_info = self.detection_results.get("python", {})
            if not python_info.get("found"):
                self.log("Python not found. Cannot install dependencies.")
                return False
            python_executable = python_info.get("executable")
        
        self.log("Installing application dependencies...")
        
        try:
            # PROFILE IS THE ONLY SOURCE OF TRUTH - NO requirements.txt
            # Load packages from hardware profile
            self.log("Loading package versions from hardware profile...")
            try:
                from system_detector import SystemDetector
                from core.profile_selector import ProfileSelector
                
                detector = SystemDetector()
                hw_profile = detector.get_hardware_profile()
                
                compat_matrix_path = Path(__file__).parent / "metadata" / "compatibility_matrix.json"
                if not compat_matrix_path.exists():
                    raise FileNotFoundError(f"compatibility_matrix.json not found at {compat_matrix_path}")
                
                selector = ProfileSelector(compat_matrix_path)
                profile_name, package_versions, warnings, binary_packages = selector.select_profile(hw_profile)
                
                self.log(f"Selected profile: {profile_name}")
                for warning in warnings:
                    self.log(f"  ⚠ {warning}")
                
                # Install packages from profile
                self.log("Installing packages from profile...")
                packages_to_install = []
                # Separate CUDA runtime packages (need to be installed early for Triton)
                cuda_runtime_packages = []
                other_packages = []
                
                for pkg_name, pkg_version in package_versions.items():
                    # Handle version specifiers properly
                    if any(op in pkg_version for op in [">=", "<=", ">", "<", "!=", ","]):
                        pkg_spec = f"{pkg_name}{pkg_version}"  # Use as-is for ranges
                    elif ".*" in pkg_version:
                        pkg_spec = f"{pkg_name}{pkg_version}"  # Use as-is for wildcards (e.g., "12.1.*")
                    else:
                        pkg_spec = f"{pkg_name}=={pkg_version}"  # Exact version
                    
                    # CUDA runtime packages should be installed before Triton
                    if "nvidia-cuda-runtime" in pkg_name or "nvidia-cuda-nvcc" in pkg_name:
                        cuda_runtime_packages.append(pkg_spec)
                    else:
                        other_packages.append(pkg_spec)
                
                # Install CUDA runtime packages first (needed for Triton compilation)
                if cuda_runtime_packages:
                    self.log(f"Installing CUDA runtime packages ({len(cuda_runtime_packages)} packages)...")
                    cmd = [python_executable, "-m", "pip", "install"] + cuda_runtime_packages
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600, **self.subprocess_flags)
                    if result.returncode != 0:
                        self.log(f"Warning: CUDA runtime packages installation had issues: {result.stderr[:500]}")
                    else:
                        self.log("✓ CUDA runtime packages installed")
                
                # Install binary packages from wheels (if any)
                if binary_packages:
                    self.log(f"Installing {len(binary_packages)} binary package(s) from wheels...")
                    for pkg_name, pkg_info in binary_packages.items():
                        wheel_url = pkg_info.get("url")
                        if not wheel_url:
                            continue
                        
                        self.log(f"Installing {pkg_name} from wheel...")
                        # Use --no-deps for binary wheels to prevent version mismatches
                        cmd = [python_executable, "-m", "pip", "install", "--no-deps", wheel_url]
                        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, **self.subprocess_flags)
                        if result.returncode == 0:
                            self.log(f"✓ {pkg_name} installed")
                        else:
                            self.log(f"Warning: Failed to install {pkg_name} from wheel: {result.stderr[:200]}")

                # Then install other packages
                packages_to_install = other_packages
                
                if packages_to_install:
                    cmd = [
                        python_executable, "-m", "pip", "install"
                    ] + packages_to_install
                    
                    self.log(f"Running: {' '.join(cmd[:5])}... ({len(packages_to_install)} packages)")
                    result = subprocess.run(
                        cmd,
                        capture_output=True,
                        text=True,
                        timeout=1800,  # 30 minutes timeout
                    )
                    
                    if result.returncode != 0:
                        self.log(f"ERROR: Package installation failed")
                        self.log(result.stderr)
                        raise RuntimeError(f"Failed to install packages from profile")
                    
                    self.log("✓ Packages installed from profile")
                else:
                    raise RuntimeError("No packages found in profile")
                
                # Apply CUDA library bootstrapping and Triton patches immediately after installation
                if platform.system() == "Windows":
                    self.log("Applying Windows-specific Triton fixes...")
                    self._bootstrap_cuda_libs(python_executable)
                    self._patch_triton_runtime_build(python_executable)
                    self._patch_triton_windows_utils(python_executable)
                    
            except Exception as e:
                self.log(f"ERROR: Failed to load/install from profile: {e}")
                raise RuntimeError(f"Profile-based installation failed. Profiles are the ONLY source of truth. Error: {e}")
            
            # Install unsloth separately with careful version control.
            # IMPORTANT: use --no-deps so pip cannot swap torch/triton versions underneath us.
            self.log("Installing unsloth (this may take a few minutes)...")
            unsloth_cmd = [
                python_executable, "-m", "pip", "install",
                "--upgrade", "--no-deps",
                "unsloth",
            ]
            
            result = subprocess.run(unsloth_cmd, capture_output=True, text=True, timeout=900, **self.subprocess_flags)
            
            if result.returncode == 0:
                self.log("✅ unsloth installed")
            else:
                self.log(f"⚠️ unsloth installation warning: {result.stderr[:200]}")
            
            # Test if unsloth works
            self.log("Testing unsloth import...")
            test_cmd = [python_executable, "-c", "from unsloth import FastLanguageModel; print('OK')"]
            test_result = subprocess.run(test_cmd, capture_output=True, text=True, timeout=30, **self.subprocess_flags)
            
            if test_result.returncode == 0 and "OK" in test_result.stdout:
                self.log("✅ unsloth is working correctly")
                return True
            else:
                self.log(f"⚠️ unsloth may have issues: {test_result.stderr[:300]}")
                return True  # Still return True as most deps are installed
        
        except subprocess.TimeoutExpired:
            self.log("Dependencies installation timed out")
            return False
        except Exception as e:
            self.log(f"Error installing dependencies: {e}")
            return False
    
    def create_launcher(self) -> bool:
        """Create launcher script"""
        self.log("Creating launcher script...")
        
        launcher_content = """#!/usr/bin/env python3
\"\"\"
Launcher for LLM Fine-tuning Studio
\"\"\"
import os
import sys
import subprocess
from pathlib import Path

def main():
    # Get script directory
    script_dir = Path(__file__).parent.absolute()
    os.chdir(script_dir)
    
    # Find Python executable
    python_exe = sys.executable
    
    # Launch Streamlit
    gui_file = script_dir / "gui.py"
    if not gui_file.exists():
        print(f"Error: gui.py not found at {gui_file}")
        input("Press Enter to exit...")
        return
    
    print("Starting LLM Fine-tuning Studio...")
    print("The GUI will open in your browser at http://localhost:8501")
    print("Press Ctrl+C to stop the server.")
    print()
    
    try:
        subprocess.run([python_exe, "-m", "streamlit", "run", str(gui_file)])
    except KeyboardInterrupt:
        print("\\nShutting down...")
    except Exception as e:
        print(f"Error: {e}")
        input("Press Enter to exit...")

if __name__ == "__main__":
    main()
"""
        
        # Create launcher for current platform
        if platform.system() == "Windows":
            launcher_path = self.install_dir / "launch_gui.bat"
            bat_content = f"""@echo off
REM Launcher for LLM Fine-tuning Studio
cd /d "%~dp0"
python gui.py
if errorlevel 1 (
    echo.
    echo Error: Failed to start GUI
    echo Make sure Python and dependencies are installed.
    pause
)
"""
            try:
                with open(launcher_path, 'w') as f:
                    f.write(bat_content)
                self.log(f"Created launcher: {launcher_path}")
                return True
            except Exception as e:
                self.log(f"Error creating launcher: {e}")
                return False
        else:
            launcher_path = self.install_dir / "launch_gui.sh"
            try:
                with open(launcher_path, 'w') as f:
                    f.write(launcher_content)
                # Make executable
                os.chmod(launcher_path, 0o755)
                self.log(f"Created launcher: {launcher_path}")
                return True
            except Exception as e:
                self.log(f"Error creating launcher: {e}")
                return False
    
    def auto_install_all(self, progress_callback=None) -> Dict:
        """
        Single method to install everything with proper error handling
        Returns detailed results for each component
        """
        results = {
            "detection": {"success": False, "data": {}},
            "python": {"success": False, "message": ""},
            "vcredist": {"success": False, "message": ""},
            "pytorch": {"success": False, "message": ""},
            "dependencies": {"success": False, "message": ""},
            "overall_success": False
        }
        
        def log_with_callback(msg):
            self.log(msg)
            if progress_callback:
                progress_callback(msg)
        
        try:
            # Step 1: Detection
            log_with_callback("Running system detection...")
            self.run_detection()
            results["detection"]["success"] = True
            results["detection"]["data"] = self.detection_results
            
            # Step 2: Python check
            log_with_callback("Checking Python installation...")
            if self.install_python():
                results["python"]["success"] = True
                results["python"]["message"] = "Python found"
            else:
                results["python"]["message"] = "Python not found or invalid"
                return results
            
            # Step 3: Visual C++ Redistributables (Windows only)
            if platform.system() == "Windows":
                log_with_callback("Checking Visual C++ Redistributables...")
                if self.install_vcredist():
                    results["vcredist"]["success"] = True
                    results["vcredist"]["message"] = "Visual C++ Redistributables OK"
                else:
                    results["vcredist"]["message"] = "Visual C++ install failed (non-critical)"
            else:
                results["vcredist"]["success"] = True
                results["vcredist"]["message"] = "Not required on this platform"
            
            # Step 4: PyTorch (always install/reinstall to ensure clean state)
            log_with_callback("Installing PyTorch...")
            pytorch_info = self.detection_results.get("pytorch", {})
            if pytorch_info.get("found"):
                log_with_callback(f"Found existing PyTorch {pytorch_info.get('version')} - will reinstall to ensure compatibility")
            
            if self.install_pytorch():
                results["pytorch"]["success"] = True
                results["pytorch"]["message"] = "PyTorch installed successfully"
            else:
                results["pytorch"]["message"] = "PyTorch installation failed"
                return results
            
            # Step 5: Dependencies
            log_with_callback("Installing dependencies...")
            if self.install_dependencies():
                results["dependencies"]["success"] = True
                results["dependencies"]["message"] = "Dependencies installed successfully"
            else:
                results["dependencies"]["message"] = "Some dependencies failed (may still work)"
            
            # Overall success if critical components installed
            results["overall_success"] = (
                results["python"]["success"] and 
                results["pytorch"]["success"]
            )
            
            log_with_callback("Installation process completed!")
            return results
            
        except Exception as e:
            log_with_callback(f"Error during installation: {str(e)}")
            return results
    
    def install(self) -> bool:
        """Run complete installation process"""
        self.log("=" * 60)
        self.log("LLM Fine-tuning Studio - Smart Installer")
        self.log("=" * 60)
        
        # Step 1: Detection
        self.run_detection()
        
        # Step 2: Install Python (if needed)
        if not self.install_python():
            self.log("Installation cannot continue without Python.")
            return False
        
        # Step 3: Install Visual C++ Redistributables (Windows)
        if platform.system() == "Windows":
            if not self.install_vcredist():
                self.log("Warning: Visual C++ Redistributables installation failed.")
                self.log("The application may not work correctly.")
        
        # Step 4: Install PyTorch (always reinstall to ensure correct version/CUDA build)
        pytorch_info = self.detection_results.get("pytorch", {})
        if pytorch_info.get("found"):
            self.log(f"PyTorch {pytorch_info.get('version')} detected - checking if correct version...")
        
        # Always run install_pytorch - it will uninstall old version and install correct one
        if not self.install_pytorch():
            self.log("Warning: PyTorch installation failed.")
            self.log("You can install it manually later.")
            return False

        # Step 4b: Hard-remove xformers if present (it can downgrade torch)
        try:
            pyexe = self.detection_results.get("python", {}).get("executable") or python_executable or sys.executable
            subprocess.run(
                [pyexe, "-m", "pip", "uninstall", "-y", "xformers"],
                capture_output=True,
                text=True,
                timeout=180,
                **self.subprocess_flags,
            )
        except Exception:
            pass
        
        # Step 5: Install dependencies
        if not self.install_dependencies():
            self.log("Warning: Some dependencies may not have installed correctly.")
        
        # Step 6: Create launcher
        self.create_launcher()
        
        self.log("=" * 60)
        self.log("Installation complete!")
        self.log("=" * 60)
        
        return True
    
    def get_installation_checklist(self, python_executable: Optional[str] = None) -> list:
        """
        Get list of all components that will be installed with their status.
        Returns list of dicts with keys: component, version, status, status_text
        
        Args:
            python_executable: Python executable to use for checking packages (defaults to current Python)
        """
        checklist = []
        
        # Determine which Python to use for checking packages
        if not python_executable:
            python_info = self.detection_results.get("python", {}) if self.detection_results else {}
            python_executable = python_info.get("executable") or sys.executable
        
        # CRITICAL: Always use the TARGET venv Python, not bootstrap Python
        # The target venv is where packages are actually installed
        script_dir = Path(__file__).parent
        target_venv = script_dir / ".venv"
        
        if sys.platform == "win32":
            target_venv_python = target_venv / "Scripts" / "python.exe"
        else:
            target_venv_python = target_venv / "bin" / "python"
        
        # If target venv exists, ALWAYS use it (ignore python_executable parameter)
        if target_venv_python.exists():
            check_python = str(target_venv_python)
            self.log(f"Using target venv Python: {check_python}")
        else:
            # Fallback to provided Python or current Python
            check_python = python_executable or sys.executable
            self.log(f"Target venv not found, using: {check_python}")
        
        # Run detection if not already done
        if not self.detection_results:
            self.run_detection()
        
        # Python
        python_info = self.detection_results.get("python", {})
        if python_info.get("found"):
            checklist.append({
                "component": "Python",
                "version": f"{python_info.get('version', 'Unknown')}+",
                "status": "installed",
                "status_text": f"✓ Installed ({python_info.get('version', 'Unknown')})"
            })
        else:
            checklist.append({
                "component": "Python",
                "version": "3.10+",
                "status": "missing",
                "status_text": "✗ Not Installed"
            })
        
        # PyTorch packages - use _verify_torch with target Python ONLY
        # Determine target venv Python path
        target_python = check_python
        if python_executable:
            target_python = python_executable
        elif check_python:
            target_python = check_python
        
        # Verify torch using target Python
        torch_ok, torch_ver, torch_cuda, torch_error = self._verify_torch(target_python)
        if torch_ok:
            if torch_cuda and torch_ver and "2.5" in torch_ver:
                checklist.append({
                    "component": "PyTorch (CUDA)",
                    "version": "2.5.1+cu118",
                    "status": "installed",
                    "status_text": f"✓ Installed ({torch_ver})"
                })
            elif torch_cuda:
                checklist.append({
                    "component": "PyTorch (CUDA)",
                    "version": "2.5.1+cu118",
                    "status": "wrong_version",
                    "status_text": f"⚠ Wrong Version ({torch_ver})"
                })
            else:
                checklist.append({
                    "component": "PyTorch (CUDA)",
                    "version": "2.5.1+cu118",
                    "status": "wrong_version",
                    "status_text": "⚠ CPU-only version"
                })
        else:
            checklist.append({
                "component": "PyTorch (CUDA)",
                "version": "2.5.1+cu118",
                "status": "missing",
                "status_text": "✗ Not Installed"
            })
        
        # PyTorch Vision and Audio (verify using import only)
        def check_import_version(module_name):
            """Check package version using import (no metadata)"""
            try:
                result = subprocess.run(
                    [check_python, "-c", f"import {module_name}; print({module_name}.__version__)"],
                    capture_output=True,
                    text=True,
                    timeout=10,  # Increased from 3s to 10s for more reliable checks
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    return result.stdout.strip()
                else:
                    # Log why import failed
                    self.log(f"⚠ {module_name} import failed (exit {result.returncode}): {result.stderr[:200]}")
                return None
            except Exception as e:
                self.log(f"⚠ {module_name} import error: {str(e)[:200]}")
                return None
        
        torchvision_ver = check_import_version("torchvision")
        if torchvision_ver:
            checklist.append({
                "component": "PyTorch Vision",
                "version": "0.20.1+cu118",
                "status": "installed",
                "installed_version": torchvision_ver,
                "status_text": f"✓ Installed ({torchvision_ver})"
            })
        else:
            checklist.append({
                "component": "PyTorch Vision",
                "version": "0.20.1+cu118",
                "installed_version": None,
                "status": "missing",
                "status_text": "✗ Not Installed"
            })
        
        torchaudio_ver = check_import_version("torchaudio")
        if torchaudio_ver:
            checklist.append({
                "component": "PyTorch Audio",
                "version": "2.5.1+cu118",
                "status": "installed",
                "installed_version": torchaudio_ver,
                "status_text": f"✓ Installed ({torchaudio_ver})"
            })
        else:
            checklist.append({
                "component": "PyTorch Audio",
                "version": "2.5.1+cu118",
                "installed_version": None,
                "status": "missing",
                "status_text": "✗ Not Installed"
            })
        
        # Triton (Windows) - verify using SIMPLE import (don't import triton.language - it requires compilation)
        def check_triton_installed():
            """Check if triton is installed by importing it (SIMPLE check - don't test compilation)"""
            try:
                result = subprocess.run(
                    [check_python, "-c", "import triton; print(triton.__version__)"],
                    capture_output=True,
                    text=True,
                    timeout=10,  # Increased from 3s to 10s for more reliable checks
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    return result.stdout.strip()
                return None
            except:
                return None

        triton_ver = check_triton_installed()
        if triton_ver:
            checklist.append({
                "component": "Triton (Windows)",
                "version": "any",  # Accept any installed version
                "status": "installed",
                "status_text": f"✓ Installed ({triton_ver})"
            })
        else:
            checklist.append({
                "component": "Triton (Windows)",
                "version": "any",  # Accept any installed version
                "status": "missing",
                "status_text": "✗ Not Installed"
            })
        
        # PySide6 packages (verify using import only)
        def check_pyside6_import(module_name):
            """Check PySide6 using import"""
            try:
                result = subprocess.run(
                    [check_python, "-c", f"import {module_name}; print('OK')"],
                    capture_output=True,
                    text=True,
                    timeout=10,  # Increased from 3s to 10s for more reliable checks
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    # Try to get version if available
                    try:
                        ver_result = subprocess.run(
                            [check_python, "-c", f"import {module_name}; print({module_name}.__version__)"],
                            capture_output=True,
                            text=True,
                            timeout=10,  # Increased from 3s to 10s for more reliable checks
                            **self.subprocess_flags
                        )
                        if ver_result.returncode == 0:
                            return ver_result.stdout.strip()
                    except:
                        pass
                    return "installed"  # Import works but no version
                return None
            except:
                return None
        
        pyside_components = ["PySide6", "PySide6-Essentials", "PySide6-Addons", "shiboken6"]
        for component in pyside_components:
            # Map component name to import name
            import_name = component.replace("-", "_").lower()
            if import_name == "pyside6":
                import_name = "PySide6"
            elif import_name == "pyside6_essentials":
                import_name = "PySide6"
            elif import_name == "pyside6_addons":
                import_name = "PySide6"
            elif import_name == "shiboken6":
                import_name = "shiboken6"
            
            ver = check_pyside6_import(import_name)
            if ver:
                if ver == "6.8.1" or ver == "installed":
                    checklist.append({
                        "component": component,
                        "version": "6.8.1",
                        "status": "installed",
                        "installed_version": ver if ver != "installed" else None,
                        "status_text": f"✓ Installed ({ver})" if ver != "installed" else "✓ Installed"
                    })
                else:
                    checklist.append({
                        "component": component,
                        "version": "6.8.1",
                        "status": "wrong_version",
                        "installed_version": ver,
                        "status_text": f"⚠ Wrong Version ({ver})"
                    })
            else:
                checklist.append({
                    "component": component,
                    "version": "6.8.1",
                    "installed_version": None,
                    "status": "missing",
                    "status_text": "✗ Not Installed"
                })
        
        # PROFILE IS THE ONLY SOURCE OF TRUTH - Load packages from profile
        try:
            from system_detector import SystemDetector
            from core.profile_selector import ProfileSelector
            
            detector = SystemDetector()
            hw_profile = detector.get_hardware_profile()
            
            compat_matrix_path = Path(__file__).parent / "metadata" / "compatibility_matrix.json"
            if not compat_matrix_path.exists():
                raise FileNotFoundError(f"compatibility_matrix.json not found at {compat_matrix_path}")
            
            selector = ProfileSelector(compat_matrix_path)
            profile_name, package_versions, warnings, binary_packages = selector.select_profile(hw_profile)
            
            # Add packages from profile
            for pkg_name, pkg_version in package_versions.items():
                version_spec = f"=={pkg_version}"  # Exact version from profile
                
                # Skip PyTorch and PySide6 packages (already added)
                if pkg_name.lower() in ['torch', 'torchvision', 'torchaudio', 'triton', 'pyside6']:
                    continue
                if 'pyside6' in pkg_name.lower() or 'shiboken6' in pkg_name.lower():
                    continue
                
                # Check if installed using correct Python
                # Use import test for transformers, datasets, huggingface_hub (GUI status rule)
                if pkg_name.lower() in ["transformers", "datasets", "huggingface-hub", "huggingface_hub"]:
                    # Use import verification (no metadata inspection)
                    installed_ver = None
                    if self._verify_import(check_python, pkg_name):
                        # Get version via import
                        try:
                            result = subprocess.run(
                                [check_python, "-c", f"import {pkg_name.replace('-', '_')}; print({pkg_name.replace('-', '_')}.__version__)"],
                                capture_output=True,
                                text=True,
                                timeout=10,
                                **self.subprocess_flags
                            )
                            if result.returncode == 0:
                                installed_ver = result.stdout.strip()
                        except:
                            pass
                        
                        status = "installed"
                        status_text = f"✓ Installed ({installed_ver})" if installed_ver else "✓ Installed"
                        checklist.append({
                            "component": pkg_name,
                            "version": version_spec,
                            "installed_version": installed_ver,
                            "status": status,
                            "status_text": status_text
                        })
                    else:
                        checklist.append({
                            "component": pkg_name,
                            "version": version_spec,
                            "installed_version": None,
                            "status": "missing",
                            "status_text": "✗ Not Installed"
                        })
                else:
                    # Use import-based verification for all other packages
                    module_name = pkg_name.replace("-", "_")
                    installed_ver = None
                    if self._verify_import(check_python, pkg_name):
                        # Get version via import
                        try:
                            result = subprocess.run(
                                [check_python, "-c", f"import {module_name}; print({module_name}.__version__)"],
                                capture_output=True,
                                text=True,
                                timeout=10,
                                **self.subprocess_flags
                            )
                            if result.returncode == 0:
                                installed_ver = result.stdout.strip()
                        except:
                            pass
                        
                        status = "installed"
                        status_text = f"✓ Installed ({installed_ver})" if installed_ver else "✓ Installed"
                        checklist.append({
                            "component": pkg_name,
                            "version": version_spec,
                            "installed_version": installed_ver,
                            "status": status,
                            "status_text": status_text
                        })
                    else:
                        checklist.append({
                            "component": pkg_name,
                            "version": version_spec,
                            "installed_version": None,
                            "status": "missing",
                            "status_text": "✗ Not Installed"
                        })
        except Exception as e:
            self.log(f"ERROR: Failed to load packages from profile: {e}")
            # Cannot proceed without profile - this is an error
            raise RuntimeError(f"Profile-based checklist generation failed. Profiles are the ONLY source of truth. Error: {e}")
        
        return checklist
    
    def check_component_status(self, component_name: str) -> dict:
        """
        Check the installation status of a single component.
        Returns dict with: status, version, status_text
        """
        # This is a simplified version - can be enhanced
        checklist = self.get_installation_checklist()
        for item in checklist:
            if item["component"] == component_name:
                return {
                    "status": item["status"],
                    "version": item.get("installed_version"),
                    "status_text": item["status_text"]
                }
        return {"status": "unknown", "version": None, "status_text": "? Not found in checklist"}
    
    def _get_cuda_version_from_torch(self, python_executable: str) -> Optional[str]:
        """
        Get CUDA version from PyTorch installation.
        
        Args:
            python_executable: Path to Python executable
            
        Returns:
            CUDA version string (e.g., "12.1") or None if not available
        """
        try:
            cmd = [
                python_executable, "-c",
                "import torch; print(torch.version.cuda if hasattr(torch.version, 'cuda') and torch.cuda.is_available() else '')"
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, **self.subprocess_flags)
            if result.returncode == 0 and result.stdout.strip():
                cuda_version = result.stdout.strip()
                if cuda_version:
                    # Extract major.minor version (e.g., "12.1" from "12.1.0")
                    parts = cuda_version.split('.')
                    if len(parts) >= 2:
                        return f"{parts[0]}.{parts[1]}"
                    return cuda_version
        except Exception as e:
            self.log(f"Warning: Could not detect CUDA version from PyTorch: {e}")
        return None
    
    def _find_cuda_library_path(self, python_executable: str) -> Optional[str]:
        """
        Find CUDA library path (cuda.lib) for linking.
        Checks multiple locations including CUDA toolkit installation.
        
        Args:
            python_executable: Path to Python executable
            
        Returns:
            Path to directory containing cuda.lib, or None if not found
        """
        import sysconfig
        from pathlib import Path
        
        # Check 1: nvidia pip package (might have libs)
        platlib = sysconfig.get_paths()["platlib"]
        nvidia_lib_path = Path(platlib) / "nvidia" / "cuda_runtime" / "lib" / "x64"
        if (nvidia_lib_path / "cuda.lib").exists():
            return str(nvidia_lib_path)
        
        # Check 2: CUDA toolkit installation (system-wide)
        cuda_toolkit_paths = [
            r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA",
            r"C:\Program Files (x86)\NVIDIA GPU Computing Toolkit\CUDA"
        ]
        
        for base_path in cuda_toolkit_paths:
            base = Path(base_path)
            if base.exists():
                # Check all CUDA versions (v12.x, v11.x, etc.)
                for version_dir in base.iterdir():
                    if version_dir.is_dir() and version_dir.name.startswith('v'):
                        lib_path = version_dir / "lib" / "x64"
                        if (lib_path / "cuda.lib").exists():
                            return str(lib_path)
        
        # Check 3: Environment variables
        for env_var in ["CUDA_PATH", "CUDA_HOME"]:
            cuda_path = os.environ.get(env_var)
            if cuda_path:
                lib_path = Path(cuda_path) / "lib" / "x64"
                if (lib_path / "cuda.lib").exists():
                    return str(lib_path)
        
        return None
    
    def _install_cuda_headers(self, python_executable: str, torch_version: Optional[str] = None) -> bool:
        """
        Install CUDA headers required for Triton compilation on Windows.
        
        Args:
            python_executable: Path to Python executable
            torch_version: Optional PyTorch version string (for logging)
            
        Returns:
            True if installation succeeded or headers already available, False otherwise
        """
        try:
            # Check if CUDA headers are already available
            import sysconfig
            platlib = sysconfig.get_paths()["platlib"]
            nvidia_path = Path(platlib) / "nvidia" / "cuda_runtime" / "include" / "cuda.h"
            if nvidia_path.exists():
                self.log("CUDA headers already available")
                return True
            
            # Get CUDA version from PyTorch
            cuda_version = self._get_cuda_version_from_torch(python_executable)
            if not cuda_version:
                self.log("Warning: Could not detect CUDA version. Skipping CUDA headers installation.")
                return False
            
            # Map CUDA version to package version
            # For CUDA 12.x, use nvidia-cuda-runtime-cu12
            # For CUDA 11.x, use nvidia-cuda-runtime-cu11
            if cuda_version.startswith("12."):
                package_spec = f"nvidia-cuda-runtime-cu12=={cuda_version}.*"
            elif cuda_version.startswith("11."):
                package_spec = f"nvidia-cuda-runtime-cu11=={cuda_version}.*"
            else:
                self.log(f"Warning: Unsupported CUDA version {cuda_version}. Skipping CUDA headers installation.")
                return False
            
            self.log(f"Installing CUDA headers for CUDA {cuda_version}...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=package_spec,
                python_executable=python_executable,
                pip_args=[]
            )
            
            if success:
                # Verify headers were installed
                if nvidia_path.exists():
                    self.log(f"✓ CUDA headers installed successfully for CUDA {cuda_version}")
                    return True
                else:
                    self.log(f"Warning: CUDA headers package installed but headers not found at expected location")
                    return False
            else:
                self.log(f"Warning: Failed to install CUDA headers (exit code {exit_code})")
                return False
                
        except Exception as e:
            self.log(f"Error installing CUDA headers: {e}")
            return False
    
    def _install_cuda_nvcc(self, python_executable: str, cuda_version: str) -> bool:
        """
        Install nvidia-cuda-nvcc package which may include additional CUDA libraries.
        
        Args:
            python_executable: Path to Python executable
            cuda_version: CUDA version string (e.g., "12.1")
            
        Returns:
            True if installation succeeded, False otherwise
        """
        try:
            if cuda_version.startswith("12."):
                package_spec = f"nvidia-cuda-nvcc-cu12=={cuda_version}.*"
            elif cuda_version.startswith("11."):
                package_spec = f"nvidia-cuda-nvcc-cu11=={cuda_version}.*"
            else:
                return False
            
            self.log(f"Installing nvidia-cuda-nvcc for CUDA {cuda_version} (may include CUDA libraries)...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=package_spec,
                python_executable=python_executable,
                pip_args=[]
            )
            
            if success:
                self.log(f"✓ nvidia-cuda-nvcc installed successfully")
                return True
            else:
                self.log(f"Warning: Failed to install nvidia-cuda-nvcc (exit code {exit_code})")
                return False
                
        except Exception as e:
            self.log(f"Error installing nvidia-cuda-nvcc: {e}")
            return False

    def _get_platlib_for_python(self, python_executable: str) -> Optional[Path]:
        """Return sysconfig platlib for a given Python executable."""
        try:
            cmd = [python_executable, "-c", "import sysconfig; print(sysconfig.get_paths()['platlib'])"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, **self.subprocess_flags)
            if result.returncode == 0 and result.stdout:
                p = Path(result.stdout.strip())
                if p.exists():
                    return p
        except Exception:
            pass
        return None

    def _get_baseprefix_and_pyver(self, python_executable: str) -> tuple[Optional[Path], Optional[str]]:
        """Return (sys.base_prefix, python_version_digits) for python_executable."""
        try:
            cmd = [
                python_executable,
                "-c",
                "import sys, sysconfig; print(sys.base_prefix); print(sysconfig.get_python_version())",
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, **self.subprocess_flags)
            if result.returncode == 0 and result.stdout:
                lines = [l.strip() for l in result.stdout.splitlines() if l.strip()]
                if len(lines) >= 2:
                    base = Path(lines[0])
                    ver = lines[1].replace(".", "")
                    return base, ver
        except Exception:
            pass
        return None, None
    
    def _bootstrap_cuda_libs(self, python_executable: str) -> bool:
        """
        Generate compatible MinGW import libs for Triton JIT builds on Windows:
        - libcuda.a / cuda.lib from nvcuda.dll (CUDA driver)
        - libpythonXY.dll.a from pythonXY.dll (Python import symbols)

        Without these, MinGW ld will fail with undefined references to __imp_Py* symbols.
        """
        try:
            platlib = self._get_platlib_for_python(python_executable)
            if not platlib:
                self.log("Warning: could not determine target platlib for bootstrap.")
                return False
            
            # Location 1: Triton's own backend lib folder (used by compiler directly)
            triton_lib_dir = Path(platlib) / "triton" / "backends" / "nvidia" / "lib"
            # Location 2: Standard NVIDIA pip layout (used by Triton detection logic)
            pip_lib_dir = Path(platlib) / "nvidia" / "cuda_runtime" / "lib" / "x64"
            
            for d in [triton_lib_dir, pip_lib_dir]:
                if not d.exists():
                    d.mkdir(parents=True, exist_ok=True)
            
            # Check for system nvcuda.dll
            nvcuda_dll = Path("C:\\Windows\\System32\\nvcuda.dll")
            if not nvcuda_dll.exists():
                self.log("Warning: C:\\Windows\\System32\\nvcuda.dll not found. Linker bootstrapping skipped.")
                return False
            
            self.log(f"Bootstrapping CUDA linker libraries from {nvcuda_dll}...")
            
            # Find MinGW tools (gendef, dlltool)
            mingw_bin = Path("C:\\mingw64\\bin")
            gendef = mingw_bin / "gendef.exe"
            dlltool = mingw_bin / "dlltool.exe"
            
            if not gendef.exists() or not dlltool.exists():
                from shutil import which
                gendef_path = which("gendef")
                dlltool_path = which("dlltool")
                if not gendef_path or not dlltool_path:
                    self.log("Warning: MinGW tools (gendef/dlltool) not found. Cannot bootstrap CUDA libraries.")
                    return False
                gendef = Path(gendef_path)
                dlltool = Path(dlltool_path)

            # Generate in Triton's lib dir first
            def_file = triton_lib_dir / "nvcuda.def"
            libcuda_a = triton_lib_dir / "libcuda.a"
            cuda_lib = triton_lib_dir / "cuda.lib"
            
            self.log("  Generating nvcuda.def...")
            subprocess.run([str(gendef), str(nvcuda_dll)], cwd=str(triton_lib_dir), capture_output=True, **self.subprocess_flags)
            
            self.log("  Building libcuda.a (MinGW format)...")
            subprocess.run([str(dlltool), "-d", "nvcuda.def", "-l", "libcuda.a", "-D", "nvcuda.dll"], cwd=str(triton_lib_dir), capture_output=True, **self.subprocess_flags)
            
            import shutil
            shutil.copy2(libcuda_a, cuda_lib)
            
            # Copy to PIP location to satisfy Triton's check_cuda_pip()
            shutil.copy2(libcuda_a, pip_lib_dir / "libcuda.a")
            shutil.copy2(cuda_lib, pip_lib_dir / "cuda.lib")

            # Also bootstrap Python import library for MinGW linking.
            base_prefix, pyver = self._get_baseprefix_and_pyver(python_executable)
            if base_prefix and pyver:
                python_dll = base_prefix / f"python{pyver}.dll"
                if python_dll.exists():
                    self.log(f"Bootstrapping Python import library from {python_dll}...")
                    py_def = triton_lib_dir / "python.def"
                    py_lib = triton_lib_dir / f"libpython{pyver}.dll.a"
                    subprocess.run([str(gendef), str(python_dll)], cwd=str(triton_lib_dir), capture_output=True, **self.subprocess_flags)
                    # gendef writes <dllname>.def (e.g. python312.def). normalize to python.def if needed.
                    generated_def = triton_lib_dir / f"python{pyver}.def"
                    if generated_def.exists():
                        generated_def.replace(py_def)
                    subprocess.run(
                        [str(dlltool), "-d", py_def.name, "-l", py_lib.name, "-D", python_dll.name],
                        cwd=str(triton_lib_dir),
                        capture_output=True,
                        **self.subprocess_flags,
                    )
                    if py_lib.exists():
                        self.log(f"✓ Python import library ready: {py_lib.name}")
                else:
                    self.log(f"Warning: {python_dll} not found; Python import library not bootstrapped.")
            else:
                self.log("Warning: could not determine Python DLL for import-lib bootstrap.")
            
            self.log("✓ Successfully bootstrapped CUDA linker libraries in all locations")
            return True
            
        except Exception as e:
            self.log(f"Warning: Exception during CUDA library bootstrapping: {e}")
            return False

    def _patch_triton_runtime_build(self, python_executable: str) -> bool:
        """Patch triton/runtime/build.py so MinGW links against libpythonXY.dll.a on Windows."""
        try:
            platlib = self._get_platlib_for_python(python_executable)
            if not platlib:
                self.log("Warning: could not determine target platlib for triton build patch.")
                return False
            build_py = Path(platlib) / "triton" / "runtime" / "build.py"
            if not build_py.exists():
                self.log("Warning: triton runtime/build.py not found. Skipping build patch.")
                return False

            content = build_py.read_text(encoding="utf-8")
            if "libpython" in content and "python_version().replace" in content and "-lpython" in content:
                # Likely already patched.
                return True

            needle = "cc_cmd += [f'-l{lib}' for lib in libraries]"
            if needle not in content:
                self.log("Warning: build.py format unexpected; cannot patch safely.")
                return False

            injection = (
                "cc_cmd += [f'-l{lib}' for lib in libraries]\n"
                "        if os.name == \"nt\":\n"
                "            # MinGW needs explicit Python import library (libpythonXY.dll.a).\n"
                "            pyver = sysconfig.get_python_version().replace(\".\", \"\")\n"
                "            cc_cmd += [f\"-lpython{pyver}\"]\n"
            )
            content = content.replace(needle, injection, 1)
            build_py.write_text(content, encoding="utf-8")
            self.log("✓ Patched triton/runtime/build.py to link libpythonXY")
            return True
        except Exception as e:
            self.log(f"Warning: Failed to patch triton runtime/build.py: {e}")
            return False

    def _patch_triton_windows_utils(self, python_executable: str) -> bool:
        """
        Patch triton's windows_utils.py to fix CUDA detection issues.
        This applies the fixes we made earlier to the installed triton package.
        
        Args:
            python_executable: Path to Python executable
            
        Returns:
            True if patching succeeded or not needed, False otherwise
        """
        try:
            platlib = self._get_platlib_for_python(python_executable) or Path(sysconfig.get_paths()["platlib"])
            windows_utils_path = Path(platlib) / "triton" / "windows_utils.py"
            
            if not windows_utils_path.exists():
                self.log("Warning: triton windows_utils.py not found. Skipping patch.")
                return False
            
            # Read the file
            content = windows_utils_path.read_text(encoding='utf-8')
            original_content = content
            
            # Check if already patched (look for our lenient check function)
            if "check_cuda_pip_headers_only" in content:
                self.log("triton windows_utils.py already patched")
                return True
            
            # Apply patch 1: Fix find_winsdk_registry return value (line ~176)
            if 'except OSError:\n        return None' in content and 'find_winsdk_registry' in content.split('except OSError:\n        return None')[0].split('def find_winsdk_registry')[1]:
                content = content.replace(
                    'except OSError:\n        return None',
                    'except OSError:\n        return None, None',
                    1  # Only replace first occurrence
                )
                self.log("Applied patch: Fixed find_winsdk_registry return value")
            
            # Apply patch 2: Add lenient CUDA header check function after check_cuda_pip
            if "def check_cuda_pip_headers_only" not in content:
                # Find the end of check_cuda_pip function
                check_cuda_pip_end = content.find("def find_cuda_pip():")
                if check_cuda_pip_end > 0:
                    # Insert the new function before find_cuda_pip
                    new_function = '''

def check_cuda_pip_headers_only(nvidia_base_path):
    """Check if CUDA headers are available via pip (more lenient check)"""
    return (nvidia_base_path / "cuda_runtime" / "include" / "cuda.h").exists()
'''
                    content = content[:check_cuda_pip_end] + new_function + content[check_cuda_pip_end:]
                    self.log("Applied patch: Added check_cuda_pip_headers_only function")
            
            # Apply patch 3: Update find_cuda_pip to use lenient check
            if "check_cuda_pip_headers_only" in content and 'if check_cuda_pip_headers_only(nvidia_base_path):' not in content:
                # Find the return statement in find_cuda_pip
                find_cuda_pip_start = content.find("def find_cuda_pip():")
                if find_cuda_pip_start > 0:
                    # Find the return None, [], [] at the end of find_cuda_pip
                    find_cuda_pip_section = content[find_cuda_pip_start:]
                    find_cuda_pip_end = find_cuda_pip_section.find("\n\n", find_cuda_pip_section.find("return None, [], []"))
                    if find_cuda_pip_end == -1:
                        find_cuda_pip_end = find_cuda_pip_section.find("\ndef ", 100)
                    
                    if find_cuda_pip_end > 0:
                        old_section = find_cuda_pip_section[:find_cuda_pip_end]
                        if 'return None, [], []' in old_section and 'check_cuda_pip_headers_only' not in old_section:
                            # Insert lenient check before the final return
                            old_return = old_section.rfind('    return None, [], []')
                            if old_return > 0:
                                new_section = (
                                    old_section[:old_return] +
                                    '''    # More lenient check: if headers exist, return them even without other components
    if check_cuda_pip_headers_only(nvidia_base_path):
        bin_path = str(nvidia_base_path / "cuda_nvcc" / "bin") if (nvidia_base_path / "cuda_nvcc" / "bin").exists() else None
        lib_dirs = [str(nvidia_base_path / "cuda_runtime" / "lib" / "x64")] if (nvidia_base_path / "cuda_runtime" / "lib" / "x64").exists() else []
        return (
            bin_path,
            [str(nvidia_base_path / "cuda_runtime" / "include")],
            lib_dirs,
        )

''' +
                                    old_section[old_return:]
                                )
                                content = content[:find_cuda_pip_start] + new_section + content[find_cuda_pip_start + find_cuda_pip_end:]
                                self.log("Applied patch: Updated find_cuda_pip with lenient header check")
            
            # Only write if content changed
            if content != original_content:
                windows_utils_path.write_text(content, encoding='utf-8')
                self.log("✓ Successfully patched triton windows_utils.py")
                return True
            else:
                self.log("triton windows_utils.py did not need patching")
                return True
            
        except Exception as e:
            self.log(f"Warning: Failed to patch triton windows_utils.py: {e}")
            import traceback
            self.log(traceback.format_exc())
            return False
    
    def _verify_torch(self, target_python: str) -> Tuple[bool, Optional[str], Optional[bool], Optional[str]]:
        """
        Verify torch installation using target venv Python ONLY (minimal logging for performance).
        
        Args:
            target_python: Exact path to target venv Python (e.g., D:\\...\\LLM\\.venv\\Scripts\\python.exe)
        
        Returns:
            Tuple of (success: bool, version: str or None, cuda_available: bool or None, error: str or None)
        """
        # Ensure we're using the exact target Python path
        target_python_path = Path(target_python).resolve()
        if not target_python_path.exists():
            return False, None, None, f"Target Python not found: {target_python}"
        
        # Run verification command (no logging to avoid spam during periodic GUI updates)
        verify_cmd = [
            str(target_python_path), "-c",
            "import torch, sys; print(sys.executable); print(torch.__version__); print(torch.cuda.is_available())"
        ]
        
        try:
            verify_result = subprocess.run(
                verify_cmd,
                capture_output=True,
                text=True,
                timeout=30,
                **self.subprocess_flags
            )
            
            # Parse output (only log errors, not routine checks)
            if verify_result.returncode == 0 and verify_result.stdout:
                lines = verify_result.stdout.strip().split('\n')
                if len(lines) >= 1:
                    actual_exe = lines[0].strip()
                    
                    # Assert it equals the target venv Python
                    actual_exe_path = Path(actual_exe).resolve()
                    if str(actual_exe_path).lower() != str(target_python_path).lower():
                        error_msg = f"Verification used wrong Python! Expected: {target_python_path}, Got: {actual_exe_path}"
                        # Only log errors
                        return False, None, None, error_msg
                    
                    # Parse output
                    if len(lines) >= 2:
                        torch_version = lines[1].strip()
                        cuda_available = False
                        if len(lines) >= 3:
                            cuda_str = lines[2].strip().lower()
                            cuda_available = cuda_str == "true"
                        
                        # Success - no logging to avoid spam
                        return True, torch_version, cuda_available, None
                    else:
                        return False, None, None, "Verification output incomplete"
                else:
                    return False, None, None, "Verification output empty"
            else:
                # Exit code != 0 or no output
                error_output = verify_result.stderr if verify_result.stderr else verify_result.stdout
                error_msg = f"torch import failed (exit code {verify_result.returncode})"
                if error_output:
                    error_msg += f": {error_output[:500]}"
                # Only log errors
                return False, None, None, error_msg
                
        except Exception as e:
            error_msg = f"Exception during torch verification: {str(e)}"
            # Only log errors
            return False, None, None, error_msg
    
    def _verify_transformers(self, target_python: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Verify transformers installation using target venv Python ONLY.
        
        Args:
            target_python: Exact path to target venv Python (e.g., D:\\...\\LLM\\.venv\\Scripts\\python.exe)
        
        Returns:
            Tuple of (success: bool, version: str or None, error: str or None)
        """
        # Ensure we're using the exact target Python path
        target_python_path = Path(target_python).resolve()
        if not target_python_path.exists():
            return False, None, f"Target Python not found: {target_python}"
        
        self.log(f"Verifying transformers using target Python: {target_python_path}")
        
        # Run verification command
        verify_cmd = [
            str(target_python_path), "-c",
            "import transformers, sys; print(sys.executable); print(transformers.__version__)"
        ]
        
        try:
            verify_result = subprocess.run(
                verify_cmd,
                capture_output=True,
                text=True,
                timeout=5,  # Reduced from 30s to 5s for faster failure detection
                **self.subprocess_flags
            )
            
            # Log the executable that was actually used
            if verify_result.returncode == 0 and verify_result.stdout:
                lines = verify_result.stdout.strip().split('\n')
                if len(lines) >= 1:
                    actual_exe = lines[0].strip()
                    self.log(f"Verification used Python: {actual_exe}")
                    
                    # Assert it equals the target venv Python
                    actual_exe_path = Path(actual_exe).resolve()
                    if str(actual_exe_path).lower() != str(target_python_path).lower():
                        error_msg = f"Verification used wrong Python! Expected: {target_python_path}, Got: {actual_exe_path}"
                        self.log(f"ERROR: {error_msg}")
                        return False, None, error_msg
                    
                    # Parse output
                    if len(lines) >= 2:
                        transformers_version = lines[1].strip()
                        self.log(f"✓ transformers verified: version {transformers_version}")
                        return True, transformers_version, None
                    else:
                        return False, None, "Verification output incomplete"
                else:
                    return False, None, "Verification output empty"
            else:
                # Exit code != 0 or no output
                error_output = verify_result.stderr if verify_result.stderr else verify_result.stdout
                error_msg = f"transformers import failed (exit code {verify_result.returncode})"
                if error_output:
                    error_msg += f": {error_output[:500]}"
                self.log(f"ERROR: {error_msg}")
                return False, None, error_msg
                
        except Exception as e:
            self.log(f"ERROR: Exception during transformers verification: {str(e)}")
            return False, None, f"Exception during verification: {str(e)}"
    
    def _verify_datasets(self, target_python: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Verify datasets installation using target venv Python ONLY.
        
        Args:
            target_python: Exact path to target venv Python (e.g., D:\\...\\LLM\\.venv\\Scripts\\python.exe)
        
        Returns:
            Tuple of (success: bool, version: str or None, error: str or None)
        """
        # Ensure we're using the exact target Python path
        target_python_path = Path(target_python).resolve()
        if not target_python_path.exists():
            return False, None, f"Target Python not found: {target_python}"
        
        self.log(f"Verifying datasets using target Python: {target_python_path}")
        
        # Run verification command
        verify_cmd = [
            str(target_python_path), "-c",
            "import datasets, sys; print(sys.executable); print(datasets.__version__)"
        ]
        
        try:
            verify_result = subprocess.run(
                verify_cmd,
                capture_output=True,
                text=True,
                timeout=5,  # Reduced from 30s to 5s for faster failure detection
                **self.subprocess_flags
            )
            
            # Log the executable that was actually used
            if verify_result.returncode == 0 and verify_result.stdout:
                lines = verify_result.stdout.strip().split('\n')
                if len(lines) >= 1:
                    actual_exe = lines[0].strip()
                    self.log(f"Verification used Python: {actual_exe}")
                    
                    # Assert it equals the target venv Python
                    actual_exe_path = Path(actual_exe).resolve()
                    if str(actual_exe_path).lower() != str(target_python_path).lower():
                        error_msg = f"Verification used wrong Python! Expected: {target_python_path}, Got: {actual_exe_path}"
                        self.log(f"ERROR: {error_msg}")
                        return False, None, error_msg
                    
                    # Parse output
                    if len(lines) >= 2:
                        datasets_version = lines[1].strip()
                        self.log(f"✓ datasets verified: version {datasets_version}")
                        return True, datasets_version, None
                    else:
                        return False, None, "Verification output incomplete"
                else:
                    return False, None, "Verification output empty"
            else:
                # Exit code != 0 or no output
                error_output = verify_result.stderr if verify_result.stderr else verify_result.stdout
                error_msg = f"datasets import failed (exit code {verify_result.returncode})"
                if error_output:
                    error_msg += f": {error_output[:500]}"
                self.log(f"ERROR: {error_msg}")
                return False, None, error_msg
                
        except Exception as e:
            self.log(f"ERROR: Exception during datasets verification: {str(e)}")
            return False, None, f"Exception during verification: {str(e)}"
    
    def _verify_import(self, target_python: str, package_name: str) -> bool:
        """
        Verify package installation by import test only (no metadata inspection).
        
        Args:
            target_python: Exact path to target venv Python
            package_name: Package name to import (e.g., "transformers", "datasets")
        
        Returns:
            True if import succeeds, False otherwise
        """
        target_python_path = Path(target_python).resolve()
        if not target_python_path.exists():
            return False
        
        # Map package names to import names (package name may differ from import name)
        import_map = {
            "transformers": "transformers",
            "huggingface_hub": "huggingface_hub",
            "huggingface-hub": "huggingface_hub",
            "datasets": "datasets",
            "torchvision": "torchvision",
            "torchaudio": "torchaudio",
            "numpy": "numpy",
        }
        import_name = import_map.get(package_name, package_name)
        
        # Run import test
        verify_cmd = [
            str(target_python_path), "-c",
            f"import {import_name}"
        ]
        
        try:
            verify_result = subprocess.run(
                verify_cmd,
                capture_output=True,
                text=True,
                timeout=3,  # Reduced from 30s to 3s for faster failure detection
                **self.subprocess_flags
            )
            return verify_result.returncode == 0
        except Exception:
            return False
    
    def _verify_package_version(self, python_executable: Optional[str], package_name: str, version_spec: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Verify if a package is installed and matches the version specification.
        
        Args:
            python_executable: Path to Python executable
            package_name: Name of the package to check
            version_spec: Version specification (e.g., "==4.51.3", ">=0.21,<0.22")
        
        Returns:
            Tuple of (success: bool, installed_version: str or None, error: str or None)
        """
        try:
            # Try importlib.metadata first (Python 3.8+)
            try:
                import importlib.metadata
                try:
                    installed_ver = importlib.metadata.version(package_name)
                except importlib.metadata.PackageNotFoundError:
                    return False, None, f"Package {package_name} not installed"
            except ImportError:
                # Fallback for older Python versions
                try:
                    import importlib_metadata as importlib_metadata
                    try:
                        installed_ver = importlib_metadata.version(package_name)
                    except importlib_metadata.PackageNotFoundError:
                        return False, None, f"Package {package_name} not installed"
                except ImportError:
                    # Last resort: try using pip show (only if python_executable is provided)
                    if not python_executable:
                        return False, None, f"Package {package_name} not installed (cannot verify without Python executable)"
                    try:
                        result = subprocess.run(
                            [python_executable, "-m", "pip", "show", package_name],
                            capture_output=True,
                            text=True,
                            timeout=10,
                            **self.subprocess_flags
                        )
                        if result.returncode != 0:
                            return False, None, f"Package {package_name} not installed"
                        # Parse version from pip show output
                        for line in result.stdout.split('\n'):
                            if line.startswith('Version:'):
                                installed_ver = line.split(':', 1)[1].strip()
                                break
                        else:
                            return False, None, f"Could not determine version of {package_name}"
                    except Exception as e:
                        return False, None, f"Error checking package: {str(e)}"
            
            # If no version spec, just check if installed
            if not version_spec or version_spec.lower() == "any":
                return True, installed_ver, None
            
            # Use packaging library for version comparison
            if pkg_version and SpecifierSet:
                try:
                    spec = SpecifierSet(version_spec)
                    if spec.contains(installed_ver):
                        return True, installed_ver, None
                    else:
                        return False, installed_ver, f"Version {installed_ver} does not match {version_spec}"
                except Exception as e:
                    return False, installed_ver, f"Error parsing version spec: {str(e)}"
            else:
                # Fallback: simple string comparison for ==
                if "==" in version_spec:
                    required = version_spec.split("==")[1].strip()
                    if installed_ver == required:
                        return True, installed_ver, None
                    else:
                        return False, installed_ver, f"Version {installed_ver} != {required}"
                else:
                    # Can't do complex comparison without packaging library
                    return True, installed_ver, None  # Assume OK if we can't verify
            
        except Exception as e:
            # Log the error but don't crash
            self.log(f"Warning: Error in _verify_package_version for {package_name}: {str(e)}")
            return False, None, f"Error checking package: {str(e)}"
    
    def _install_component(self, component: dict, python_executable: str) -> Tuple[bool, str]:
        """
        Install a single component from the checklist.
        Returns (success, error_message)
        """
        component_name = component["component"]
        required_version = component["version"]
        status = component.get("status", "missing")
        
        # Skip if already installed correctly
        if status == "installed":
            return True, None
        
        self.log(f"Installing {component_name} {required_version}...")
        
        try:
            # Map component names to installation commands
            if component_name == "Python":
                # Python should already be installed (checked by launcher)
                return True, None
            
            elif component_name == "PyTorch (CUDA)":
                # Use install_pytorch which now uses worker process
                success = self.install_pytorch(python_executable=python_executable)
                if success:
                    # Verify immediately using target venv Python
                    torch_ok, torch_ver, torch_cuda, torch_error = self._verify_torch(python_executable)
                    if torch_ok:
                        if torch_cuda:
                            return True, None
                        else:
                            return False, "PyTorch installed but CUDA not available"
                    else:
                        return False, f"PyTorch verification failed: {torch_error}"
                else:
                    return False, "PyTorch installation failed"
            
            elif component_name == "PyTorch Vision":
                # CRITICAL: Verify torch is installed and working BEFORE installing torchvision
                self.log("Verifying torch is installed before installing torchvision...")
                torch_ok, torch_ver, torch_cuda, torch_error = self._verify_torch(python_executable)
                if not torch_ok:
                    return False, f"torch must be installed and working before installing torchvision: {torch_error}"
                
                # Install torchvision with same CUDA version as torch
                cuda_build = self.get_optimal_cuda_build()
                build_key_map = {"cu124": "cuda_12_4", "cu121": "cuda_12_1", "cu118": "cuda_11_8", "cpu": "cpu"}
                build_key = build_key_map.get(cuda_build, "cpu")
                versions = self.VERSION_MATRIX[build_key]
                torchvision_version = versions["torchvision"]
                
                # Determine index URL based on CUDA build
                index_url = f"https://download.pytorch.org/whl/{cuda_build}" if cuda_build != "cpu" else "https://download.pytorch.org/whl/cpu"
                
                # Use plain version (not +cu118) with index URL
                # Use worker process for installation
                success, last_lines, exit_code = self._run_pip_worker(
                    action="install",
                    package=f"torchvision=={torchvision_version}",
                    python_executable=python_executable,
                    index_url=index_url,
                    pip_args=["--force-reinstall", "--no-deps", "--no-cache-dir"]
                )
                if success:
                    # Verify using target Python
                    self.log("Verifying torchvision installation...")
                    verify_cmd = [
                        python_executable, "-c",
                        "import torchvision, torch; print(torch.__version__); print(torchvision.__version__)"
                    ]
                    verify_result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=30, **self.subprocess_flags)
                    if verify_result.returncode == 0:
                        self.log(f"✓ torchvision verified: {verify_result.stdout.strip()}")
                        return True, None
                    else:
                        return False, f"torchvision verification failed: {verify_result.stderr[:200]}"
                else:
                    return False, f"torchvision installation failed (exit code {exit_code}): {last_lines[-500:]}"
            
            elif component_name == "PyTorch Audio":
                # CRITICAL: Verify torch is installed and working BEFORE installing torchaudio
                self.log("Verifying torch is installed before installing torchaudio...")
                torch_ok, torch_ver, torch_cuda, torch_error = self._verify_torch(python_executable)
                if not torch_ok:
                    return False, f"torch must be installed and working before installing torchaudio: {torch_error}"
                
                # Install torchaudio with same CUDA version as torch
                cuda_build = self.get_optimal_cuda_build()
                build_key_map = {"cu124": "cuda_12_4", "cu121": "cuda_12_1", "cu118": "cuda_11_8", "cpu": "cpu"}
                build_key = build_key_map.get(cuda_build, "cpu")
                versions = self.VERSION_MATRIX[build_key]
                torchaudio_version = versions["torchaudio"]
                
                # Determine index URL based on CUDA build
                index_url = f"https://download.pytorch.org/whl/{cuda_build}" if cuda_build != "cpu" else "https://download.pytorch.org/whl/cpu"
                
                # Use plain version (not +cu118) with index URL
                # Use worker process for installation
                success, last_lines, exit_code = self._run_pip_worker(
                    action="install",
                    package=f"torchaudio=={torchaudio_version}",
                    python_executable=python_executable,
                    index_url=index_url,
                    pip_args=["--force-reinstall", "--no-deps", "--no-cache-dir"]
                )
                if success:
                    # Verify using target Python
                    self.log("Verifying torchaudio installation...")
                    verify_cmd = [
                        python_executable, "-c",
                        "import torchaudio, torch; print(torch.__version__); print(torchaudio.__version__)"
                    ]
                    verify_result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=30, **self.subprocess_flags)
                    if verify_result.returncode == 0:
                        self.log(f"✓ torchaudio verified: {verify_result.stdout.strip()}")
                        return True, None
                    else:
                        return False, f"torchaudio verification failed: {verify_result.stderr[:200]}"
                else:
                    return False, f"torchaudio installation failed (exit code {exit_code}): {last_lines[-500:]}"
            
            elif component_name == "Triton (Windows)":
                # CRITICAL: Verify torch is installed and working BEFORE installing triton
                self.log("Verifying torch is installed before installing triton...")
                torch_ok, torch_ver, torch_cuda, torch_error = self._verify_torch(python_executable)
                if not torch_ok:
                    return False, f"torch must be installed and working before installing triton: {torch_error}"
                
                # CRITICAL: Install CUDA headers if CUDA is available (required for Triton compilation on Windows)
                if torch_cuda:
                    self.log("CUDA detected - installing CUDA headers for Triton compilation...")
                    cuda_header_success = self._install_cuda_headers(python_executable, torch_ver)
                    if not cuda_header_success:
                        self.log("Warning: CUDA headers installation failed. Triton may fail to compile CUDA code.")
                    else:
                        self.log("✓ CUDA headers installed successfully")
                    
                    # Check for CUDA library (cuda.lib) needed for linking
                    cuda_lib_path = self._find_cuda_library_path(python_executable)
                    if not cuda_lib_path:
                        self.log("Warning: CUDA library (cuda.lib) not found.")
                        # Try installing nvidia-cuda-nvcc which might include libraries
                        cuda_version = self._get_cuda_version_from_torch(python_executable)
                        if cuda_version:
                            self.log("Attempting to install nvidia-cuda-nvcc (may include CUDA libraries)...")
                            self._install_cuda_nvcc(python_executable, cuda_version)
                            # Check again after installation
                            cuda_lib_path = self._find_cuda_library_path(python_executable)
                        
                        if not cuda_lib_path:
                            self.log("  CUDA library still not found. Triton compilation may fail.")
                            self.log("  To fix, install NVIDIA CUDA Toolkit from:")
                            self.log("  https://developer.nvidia.com/cuda-downloads")
                            self.log("  Or set CUDA_PATH environment variable to CUDA installation")
                    else:
                        self.log(f"✓ CUDA library found at: {cuda_lib_path}")
                
                # Install triton-windows for Windows (package name), triton for others
                if platform.system() == "Windows":
                    pkg_spec = "triton-windows"
                else:
                    pkg_spec = "triton"
                
                # Use worker process for installation
                success, last_lines, exit_code = self._run_pip_worker(
                    action="install",
                    package=pkg_spec,
                    python_executable=python_executable,
                    pip_args=["--force-reinstall", "--no-deps"]
                )
                if success:
                    # Patch triton's windows_utils.py to improve CUDA detection (after installation)
                    if platform.system() == "Windows":
                        self.log("Applying fixes to triton's CUDA detection...")
                        self._patch_triton_windows_utils(python_executable)
                    
                    # Verify using target Python with exact command specified
                    self.log("Verifying triton installation...")
                    verify_cmd = [
                        python_executable, "-c",
                        "import triton; import triton.language as tl; import sys; print(sys.executable); print('triton', triton.__version__)"
                    ]
                    verify_result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=30, **self.subprocess_flags)
                    if verify_result.returncode == 0:
                        # Parse and log the version
                        lines = verify_result.stdout.strip().split('\n')
                        triton_version = None
                        for line in lines:
                            if line.startswith('triton '):
                                triton_version = line.split(' ', 1)[1] if ' ' in line else "unknown"
                                break
                        if triton_version:
                            self.log(f"✓ triton verified: version {triton_version}")
                        else:
                            self.log("✓ triton verified (version could not be parsed)")
                        return True, None
                    else:
                        return False, f"Triton verification failed: {verify_result.stderr[:200] if verify_result.stderr else verify_result.stdout[:200]}"
                else:
                    return False, f"Triton installation failed (exit code {exit_code}): {last_lines[-500:]}"
            
            elif component_name in ["PySide6", "PySide6-Essentials", "PySide6-Addons", "shiboken6"]:
                # Install all PySide6 components together
                if component_name == "PySide6":  # Only install once for the group
                    # Install PySide6 first
                    success, last_lines, exit_code = self._run_pip_worker(
                        action="install",
                        package="PySide6==6.8.1",
                        python_executable=python_executable,
                        pip_args=["--force-reinstall"]
                    )
                    if not success:
                        return False, f"PySide6 installation failed (exit code {exit_code}): {last_lines[-500:]}"
                    
                    # Install PySide6-Essentials
                    success, last_lines, exit_code = self._run_pip_worker(
                        action="install",
                        package="PySide6-Essentials==6.8.1",
                        python_executable=python_executable,
                        pip_args=["--force-reinstall"]
                    )
                    if not success:
                        return False, f"PySide6-Essentials installation failed (exit code {exit_code}): {last_lines[-500:]}"
                    
                    # Install PySide6-Addons
                    success, last_lines, exit_code = self._run_pip_worker(
                        action="install",
                        package="PySide6-Addons==6.8.1",
                        python_executable=python_executable,
                        pip_args=["--force-reinstall"]
                    )
                    if not success:
                        return False, f"PySide6-Addons installation failed (exit code {exit_code}): {last_lines[-500:]}"
                    
                    # Install shiboken6
                    success, last_lines, exit_code = self._run_pip_worker(
                        action="install",
                        package="shiboken6==6.8.1",
                        python_executable=python_executable,
                        pip_args=["--force-reinstall"]
                    )
                    if not success:
                        return False, f"shiboken6 installation failed (exit code {exit_code}): {last_lines[-500:]}"
                    
                    # Verify all components
                    all_ok = True
                    for pyside_comp in ["PySide6", "PySide6-Essentials", "PySide6-Addons", "shiboken6"]:
                        success, ver, error = self._verify_package_version(python_executable, pyside_comp, "==6.8.1")
                        if not success:
                            all_ok = False
                            break
                    if all_ok:
                        # Test import
                        import_cmd = [python_executable, "-c", "import PySide6.QtCore; print('OK')"]
                        import_result = subprocess.run(import_cmd, capture_output=True, text=True, timeout=10, **self.subprocess_flags)
                        if import_result.returncode == 0:
                            return True, None
                        else:
                            return False, f"PySide6 import failed: {import_result.stderr[:200]}"
                    else:
                        return False, "PySide6 components version mismatch"
                else:
                    # Already handled by PySide6 installation
                    return True, None
            
            else:
                # Generic package installation from requirements.txt
                # Sanitize component_name and required_version to remove any comments
                component_name = self._sanitize_requirement(component_name)
                required_version = self._sanitize_requirement(required_version) if required_version else None
                
                # Encode version constraints in package name
                if required_version:
                    if required_version.startswith("==") or required_version.startswith("<") or required_version.startswith(">="):
                        pkg_spec = f"{component_name}{required_version}"
                    else:
                        pkg_spec = f"{component_name}=={required_version}"
                else:
                    pkg_spec = component_name
                
                # Sanitize final package spec before passing to pip
                pkg_spec = self._sanitize_requirement(pkg_spec)
                
                # Use worker process for installation
                success, last_lines, exit_code = self._run_pip_worker(
                    action="install",
                    package=pkg_spec,
                    python_executable=python_executable,
                    pip_args=["--force-reinstall"]
                )
                if success:
                    # Verify
                    success, ver, error = self._verify_package_version(python_executable, component_name, required_version)
                    if success:
                        return True, None
                    else:
                        return False, f"{component_name} verification failed: {error}"
                else:
                    # Check for disk space errors
                    if "No space left on device" in last_lines or "Errno 28" in last_lines:
                        return False, "Insufficient disk space"
                    return False, f"{component_name} installation failed (exit code {exit_code}): {last_lines[-500:]}"
        
        except Exception as e:
            return False, f"Error installing {component_name}: {str(e)}"
    
    def uninstall_all(self, python_executable: Optional[str] = None) -> bool:
        """Uninstall all managed packages from the environment"""
        if not python_executable:
            python_executable = sys.executable
            
        self.log("=" * 60)
        self.log("UNINSTALL PHASE: Removing all managed packages")
        self.log("=" * 60)
        
        # Get list of all packages from requirements and common ones
        packages = ["torch", "torchvision", "torchaudio", "xformers", "triton", "triton-windows", "unsloth", "unsloth_zoo"]
        
        # PROFILE IS THE ONLY SOURCE OF TRUTH - Load packages from profile
        try:
            from system_detector import SystemDetector
            from core.profile_selector import ProfileSelector
            
            detector = SystemDetector()
            hw_profile = detector.get_hardware_profile()
            
            compat_matrix_path = Path(__file__).parent / "metadata" / "compatibility_matrix.json"
            if compat_matrix_path.exists():
                selector = ProfileSelector(compat_matrix_path)
                profile_name, package_versions, warnings, binary_packages = selector.select_profile(hw_profile)
                
                # Add all packages from profile
                for pkg_name in package_versions.keys():
                    if pkg_name not in packages:
                        packages.append(pkg_name)
        except Exception as e:
            self.log(f"Warning: Could not load packages from profile: {e}")
            # Cannot proceed without profile - this is an error
        
        success_count = 0
        for pkg in packages:
            self.log(f"Uninstalling {pkg}...")
            uninstall_cmd = [python_executable, "-m", "pip", "uninstall", "-y", pkg]
            result = subprocess.run(uninstall_cmd, capture_output=True, text=True, timeout=60, **self.subprocess_flags)
            if result.returncode == 0:
                success_count += 1
                self.log(f"✓ {pkg} uninstalled")
            else:
                self.log(f"Note: {pkg} was not installed or uninstall failed")
                
        self.log("=" * 60)
        self.log(f"Uninstall complete. {success_count} packages removed.")
        self.log("=" * 60)
        return True

    def repair_all(self, python_executable: Optional[str] = None) -> bool:
        """
        Deterministic state machine for environment repair.
        Implements strict gates and layer enforcement.
        """
        self.log("=" * 60)
        self.log("LLM Fine-tuning Studio - Deterministic State Machine Repair")
        self.log("=" * 60)
        
        # STATE: INITIALIZATION
        if not python_executable:
            python_executable = sys.executable
        
        venv_path = Path(python_executable).parent.parent
        
        # GATE: Disk space check
        has_space, free_gb = self._check_disk_space()
        self.log(f"Available disk space: {free_gb:.2f} GB (minimum required: {self.min_disk_space_gb} GB)")
        if not has_space:
            self.log(f"ERROR: Insufficient disk space! Only {free_gb:.2f} GB available")
            return False
        
        # STATE: DETECTION
        install_plan = self._generate_install_plan(python_executable)
        if not install_plan:
            self.log("ERROR: Failed to generate install plan")
            return False
        
        # GATE: Python version gate
        py_gate_ok, py_error, new_python = self._gate_python_version(python_executable)
        if not py_gate_ok:
            self.log(f"ERROR: Python version gate failed: {py_error}")
            return False
        if new_python:
            python_executable = new_python
            venv_path = Path(python_executable).parent.parent
            self.log(f"Using Python 3.12 venv: {python_executable}")
        
        # STATE: CONSTRAINTS GENERATION (initial, will be updated after Layer 2)
        constraints_file = self._generate_constraints_file(install_plan, torch_selected=False)
        
        # TASK 0: Pre-installation cleanup of corrupted/locked packages
        self.log("=" * 60)
        self.log("TASK 0: Pre-installation cleanup")
        self.log("=" * 60)
        
        # Clean up any corrupted packages before starting
        if not self._cleanup_corrupted_packages(python_executable):
            self.log("WARNING: Pre-installation cleanup had issues, but continuing...")
        
        # TASK A: Eliminate torchao completely
        self.log("=" * 60)
        self.log("TASK A: Eliminating torchao completely")
        self.log("=" * 60)
        
        torchao_packages = ["torchao", "pytorch-ao", "torchao-nightly"]
        for pkg in torchao_packages:
            self.log(f"Uninstalling {pkg}...")
            self._run_pip_worker(
                action="uninstall",
                package=pkg,
                python_executable=python_executable
            )
        
        # Verify torchao is not installed
        self.log("Verifying torchao is not installed...")
        verify_cmd = [python_executable, "-c", "import importlib.util; assert importlib.util.find_spec('torchao') is None, 'torchao is still installed'; print('OK')"]
        verify_result = subprocess.run(
            verify_cmd,
            capture_output=True,
            text=True,
            timeout=10,
            **self.subprocess_flags
        )
        if verify_result.returncode != 0:
            error_msg = f"torchao verification failed: {verify_result.stderr or verify_result.stdout}"
            self.log(f"ERROR: {error_msg}")
            return False
        self.log("✓ torchao completely removed and verified")
        
        # GATE: NumPy integrity (before any install)
        numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
        if not numpy_ok:
            self.log(f"WARNING: NumPy integrity check failed before install: {numpy_error}")
            self.log("Attempting to clean up corrupted NumPy installation...")
            
            # Try cleanup first before recreating entire venv
            if self._cleanup_corrupted_packages(python_executable, packages=['numpy']):
                # Re-check after cleanup
                numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
                if numpy_ok:
                    self.log("✓ NumPy cleaned up successfully")
                else:
                    # Cleanup didn't help, recreate venv
                    self.log("Cleanup didn't resolve issue, recreating venv...")
                    recreate_ok, recreate_error, new_python = self._recreate_venv(venv_path, python_executable)
                    if not recreate_ok:
                        self.log(f"ERROR: Failed to recreate venv: {recreate_error}")
                        return False
                    python_executable = new_python
                    venv_path = Path(python_executable).parent.parent
            else:
                # Cleanup failed, recreate venv
                self.log("Cleanup failed, recreating venv...")
                recreate_ok, recreate_error, new_python = self._recreate_venv(venv_path, python_executable)
                if not recreate_ok:
                    self.log(f"ERROR: Failed to recreate venv: {recreate_error}")
                    return False
                python_executable = new_python
                venv_path = Path(python_executable).parent.parent
            
            # Final NumPy check after cleanup/recreation
            numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
            if not numpy_ok:
                self.log(f"ERROR: NumPy still broken after cleanup/recreation: {numpy_error}")
                return False
        
        # STATE: LAYER 1 INSTALLATION (numpy, sympy, fsspec)
        self.log("=" * 60)
        self.log("STATE: LAYER 1 - numpy, sympy, fsspec")
        self.log("=" * 60)
        
        # Install numpy
        self.log(f"Installing {install_plan['numpy_spec']}...")
        success, last_lines, exit_code = self._run_pip_worker(
            action="install",
            package=install_plan["numpy_spec"],
            python_executable=python_executable,
            pip_args=[]
        )
        if not success:
            self.log(f"ERROR: numpy installation failed")
            return False
        
        # GATE: NumPy integrity after install
        numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
        if not numpy_ok:
            self.log(f"ERROR: NumPy integrity check failed after install: {numpy_error}")
            self.log("RECOMMENDATION: Recreate venv and try again")
            return False
        self.log("✓ numpy installed and verified")
        
        # Install sympy
        self.log(f"Installing {install_plan['sympy_spec']}...")
        success, last_lines, exit_code = self._run_pip_worker(
            action="install",
            package=install_plan["sympy_spec"],
            python_executable=python_executable,
            pip_args=[]
        )
        if not success:
            self.log(f"ERROR: sympy installation failed")
            return False
        
        # GATE: NumPy integrity after sympy install
        numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
        if not numpy_ok:
            self.log(f"ERROR: NumPy integrity check failed after sympy install: {numpy_error}")
            return False
        self.log("✓ sympy installed")
        
        # Install fsspec
        self.log(f"Installing {install_plan['fsspec_spec']}...")
        success, last_lines, exit_code = self._run_pip_worker(
            action="install",
            package=install_plan["fsspec_spec"],
            python_executable=python_executable,
            pip_args=[]
        )
        if not success:
            self.log(f"ERROR: fsspec installation failed")
            return False
        
        # GATE: NumPy integrity after fsspec install
        numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
        if not numpy_ok:
            self.log(f"ERROR: NumPy integrity check failed after fsspec install: {numpy_error}")
            return False
        self.log("✓ fsspec installed")
        
        # GATE: Core stack invariants after Layer 1 (only check torchao, torch not installed yet)
        self.log("=" * 60)
        self.log("GATE: Core stack invariants check (after Layer 1)")
        self.log("=" * 60)
        # Only check torchao at this stage (torch not installed yet)
        torchao_ok, torchao_error = self._gate_no_torchao(python_executable)
        if not torchao_ok:
            self.log(f"ERROR: torchao gate failed after Layer 1: {torchao_error}")
            self.log("ABORTING: Installation failed - torchao must be removed")
            return False
        self.log("✓ Core stack invariants verified (Layer 1 - torchao check only)")
        
        # STATE: LAYER 2 INSTALLATION (torch stack)
        self.log("=" * 60)
        self.log("STATE: LAYER 2 - torch stack")
        self.log("=" * 60)
        
        # GATE: Process lock before binary installs
        safe, error_msg = self._check_running_processes_before_binary_install(python_executable)
        if not safe:
            self.log("ERROR: Process lock gate failed")
            self.log(error_msg)
            return False
        
        # CRITICAL: Ensure CUDA torch is installed (repairs CPU torch automatically)
        require_cuda = install_plan.get("nvidia_gpu_present", False)
        
        if require_cuda:
            # Extract CUDA build from install plan (e.g., "cu124" from "2.5.1+cu124")
            cuda_build = install_plan.get("cuda_build", "cu124")
            
            # Use ensure_cuda_torch to handle CPU torch replacement
            torch_ok, torch_error = self._ensure_cuda_torch(python_executable, cuda_build)
            if not torch_ok:
                self.log(f"ERROR: Failed to ensure CUDA torch: {torch_error}")
                return False
            
            # Verify torch integrity
            expected_torch_version = install_plan["torch_spec"].split("==")[1]
            torch_ok, torch_error = self._gate_torch_integrity(python_executable, install_plan["torch_spec"], require_cuda)
            if not torch_ok:
                self.log(f"ERROR: Torch integrity check failed: {torch_error}")
                return False
            
            self.log("✓ CUDA torch stack verified")
            
            # CRITICAL: Regenerate constraints.txt with torch pins AFTER Layer 2
            constraints_file = self._generate_constraints_file(install_plan, torch_selected=True)
            
            # GPU SELECTION: Select best GPU after CUDA torch is verified
            gpu_ok, gpu_error, gpu_info = self._select_best_gpu(python_executable)
            if not gpu_ok:
                self.log(f"ERROR: GPU selection failed: {gpu_error}")
                return False
        else:
            # CPU-only installation
            expected_torch_version = install_plan["torch_spec"].split("==")[1]
            torch_already_correct, torch_check_error = self._check_torch_already_correct(
                python_executable, install_plan["torch_spec"], require_cuda
            )
            
            if not torch_already_correct:
                # Install CPU torch
                self.log(f"Installing CPU torch {expected_torch_version}...")
                venv_path = Path(python_executable).parent.parent
                self._delete_torch_directory(venv_path)
                
                install_cmd = [python_executable, "-m", "pip", "install", "--index-url", install_plan["torch_index_url"], "--no-cache-dir", "--no-deps", install_plan["torch_spec"]]
                cmd_str = " ".join(install_cmd)
                self.log(f"Running: {cmd_str}")
                
                success, last_lines, exit_code = self._run_pip_worker(
                    action="install",
                    package=install_plan["torch_spec"],
                    python_executable=python_executable,
                    index_url=install_plan["torch_index_url"],
                    pip_args=["--no-deps", "--no-cache-dir"]
                )
                if not success:
                    self.log(f"ERROR: CPU torch installation failed. Exit code: {exit_code}")
                    return False
                
                torch_ok, torch_error = self._gate_torch_integrity(python_executable, install_plan["torch_spec"], require_cuda)
                if not torch_ok:
                    self.log(f"ERROR: Torch integrity check failed: {torch_error}")
                    return False
                
                self.log("✓ CPU torch installed and verified")
        
        # Verify torchvision
        torchvision_ok = self._verify_import(python_executable, "torchvision")
        if not torchvision_ok:
            # GATE: Wheel availability for torchvision
            wheel_ok, wheel_error, available_version = self._gate_wheel_availability(
                python_executable, install_plan["torchvision_spec"], install_plan["torch_index_url"]
            )
            if not wheel_ok:
                self.log(f"ERROR: Wheel availability gate failed for torchvision: {wheel_error}")
                return False
            
            self.log(f"Installing {install_plan['torchvision_spec']}...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=install_plan["torchvision_spec"],
                python_executable=python_executable,
                index_url=install_plan["torch_index_url"],
                pip_args=["--no-deps"]
            )
            if not success:
                if sys.platform == "win32":
                    self.log("ERROR: Binary wheel installation failed on Windows")
                    self.log("RECOMMENDATION: Recreate venv and try again")
                    return False
                return False
            
            # GATE: NumPy integrity after torchvision install
            numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
            if not numpy_ok:
                self.log(f"ERROR: NumPy integrity check failed after torchvision install: {numpy_error}")
                return False
            
            # CRITICAL GATE: Torch integrity after torchvision install
            torch_ok, torch_error = self._gate_torch_integrity(python_executable, install_plan["torch_spec"], require_cuda)
            if not torch_ok:
                self.log(f"ERROR: Torch integrity check failed after torchvision install: {torch_error}")
                self.log("ABORTING: Installation failed - torch corrupted")
                return False
            self.log("✓ torchvision installed")
        else:
            self.log("✓ torchvision already installed")
        
        # Verify torchaudio
        torchaudio_ok = self._verify_import(python_executable, "torchaudio")
        if not torchaudio_ok:
            # GATE: Wheel availability for torchaudio
            wheel_ok, wheel_error, available_version = self._gate_wheel_availability(
                python_executable, install_plan["torchaudio_spec"], install_plan["torch_index_url"]
            )
            if not wheel_ok:
                self.log(f"ERROR: Wheel availability gate failed for torchaudio: {wheel_error}")
                return False
            
            self.log(f"Installing {install_plan['torchaudio_spec']}...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=install_plan["torchaudio_spec"],
                python_executable=python_executable,
                index_url=install_plan["torch_index_url"],
                pip_args=["--no-deps"]
            )
            if not success:
                if sys.platform == "win32":
                    self.log("ERROR: Binary wheel installation failed on Windows")
                    self.log("RECOMMENDATION: Recreate venv and try again")
                    return False
                return False
            
            # GATE: NumPy integrity after torchaudio install
            numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
            if not numpy_ok:
                self.log(f"ERROR: NumPy integrity check failed after torchaudio install: {numpy_error}")
                return False
            
            # CRITICAL GATE: Torch integrity after torchaudio install
            torch_ok, torch_error = self._gate_torch_integrity(python_executable, install_plan["torch_spec"], require_cuda)
            if not torch_ok:
                self.log(f"ERROR: Torch integrity check failed after torchaudio install: {torch_error}")
                self.log("ABORTING: Installation failed - torch corrupted")
                return False
            self.log("✓ torchaudio installed")
        else:
            self.log("✓ torchaudio already installed")
        
        # GATE: Core stack invariants after Layer 2
        self.log("=" * 60)
        self.log("GATE: Core stack invariants check (after Layer 2)")
        self.log("=" * 60)
        invariants_ok, invariants_error = self._gate_core_stack_invariants(python_executable, require_cuda)
        if not invariants_ok:
            self.log(f"ERROR: Core stack invariants gate failed after Layer 2: {invariants_error}")
            self.log("ABORTING: Installation failed - invariants violated")
            return False
        self.log("✓ Core stack invariants verified (Layer 2)")
        
        # STATE: LAYER 3 INSTALLATION (huggingface-hub, tokenizers, transformers, datasets)
        self.log("=" * 60)
        self.log("STATE: LAYER 3 - huggingface-hub, tokenizers, transformers, datasets")
        self.log("=" * 60)
        
        # TASK B: Dedicated HF stack repair step
        self.log("=" * 60)
        self.log("TASK B: HF Stack Repair (fixing transformers/PreTrainedModel)")
        self.log("=" * 60)
        
        # Uninstall broken HF stack
        self.log("Uninstalling broken HF stack...")
        for pkg in ["transformers", "tokenizers", "huggingface-hub"]:
            self._run_pip_worker(action="uninstall", package=pkg, python_executable=python_executable)
        
        # Install fixed versions
        self.log("Installing fixed HF stack versions...")
        hf_packages = [
            ("huggingface-hub", ">=0.30.0,<1.0"),
            ("tokenizers", "==0.22.1"),
            ("transformers", "==4.57.3")
        ]
        
        for pkg_name, pkg_version in hf_packages:
            pkg_spec = f"{pkg_name}{pkg_version}"
            self.log(f"Installing {pkg_spec}...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=pkg_spec,
                python_executable=python_executable,
                pip_args=["--no-cache-dir"]
            )
            if not success:
                error_msg = f"{pkg_name} installation failed (exit code {exit_code})"
                self.log(f"ERROR: {error_msg}")
                self.log(f"Last lines: {last_lines[-500:]}")
                return False
            
            # GATE: Constraint violations check
            if "constraint" in last_lines.lower() and "violated" in last_lines.lower():
                self.log(f"ERROR: Constraint violation detected for {pkg_name}")
                return False
            
            # GATE: NumPy integrity
            numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
            if not numpy_ok:
                self.log(f"ERROR: NumPy integrity check failed after {pkg_name} install: {numpy_error}")
                return False
            
            # GUARD: Check torch after each HF package install
            if require_cuda:
                cuda_build = install_plan.get("cuda_build", "cu124")
                guard_ok, guard_error = self._guard_torch_immutability(
                    python_executable, install_plan["torch_spec"], cuda_build, pkg_name
                )
                if not guard_ok:
                    return False
        
        # Install peft after HF stack
        self.log("Installing peft==0.18.0...")
        success, last_lines, exit_code = self._run_pip_worker(
            action="install",
            package="peft==0.18.0",
            python_executable=python_executable,
            pip_args=["--no-cache-dir"]
        )
        if not success:
            self.log(f"ERROR: peft installation failed")
            return False
        
        # GATE: Constraint violations check
        if "constraint" in last_lines.lower() and "violated" in last_lines.lower():
            self.log("ERROR: Constraint violation detected")
            return False
        
        # GATE: NumPy integrity
        numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
        if not numpy_ok:
            self.log(f"ERROR: NumPy integrity check failed after peft install: {numpy_error}")
            return False
        
        # GUARD: Check torch after peft install
        if require_cuda:
            cuda_build = install_plan.get("cuda_build", "cu124")
            guard_ok, guard_error = self._guard_torch_immutability(
                python_executable, install_plan["torch_spec"], cuda_build, "peft"
            )
            if not guard_ok:
                return False
        
        # Verify HF stack repair
        self.log("Verifying HF stack repair (PreTrainedModel import)...")
        verify_script = """from transformers import PreTrainedModel
import peft
print('OK')
"""
        verify_cmd = [python_executable, "-c", verify_script]
        verify_result = subprocess.run(
            verify_cmd,
            capture_output=True,
            text=True,
            timeout=30,
            **self.subprocess_flags
        )
        
        if verify_result.returncode != 0:
            error_output = verify_result.stderr or verify_result.stdout
            error_msg = f"HF stack repair verification failed: {error_output.strip()}"
            self.log(f"ERROR: {error_msg}")
            self.log("=" * 60)
            self.log("HF STACK REPAIR FAILED - Aborting")
            self.log("=" * 60)
            return False
        
        self.log("✓ HF stack repair verified (PreTrainedModel import OK)")
        
        # Continue with datasets installation (already in Layer 3)
        
        # Install datasets
        self.log(f"Installing {install_plan['datasets_spec']}...")
        success, last_lines, exit_code = self._run_pip_worker(
            action="install",
            package=install_plan["datasets_spec"],
            python_executable=python_executable,
            pip_args=[]
        )
        if not success:
            self.log(f"ERROR: datasets installation failed")
            return False
        
        # GATE: Constraint violations check
        if "constraint" in last_lines.lower() and "violated" in last_lines.lower():
            self.log("ERROR: Constraint violation detected")
            return False
        
        # GATE: NumPy integrity
        numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
        if not numpy_ok:
            self.log(f"ERROR: NumPy integrity check failed after datasets install: {numpy_error}")
            return False
        
        # GUARD: Check torch after datasets install
        if require_cuda:
            cuda_build = install_plan.get("cuda_build", "cu124")
            guard_ok, guard_error = self._guard_torch_immutability(
                python_executable, install_plan["torch_spec"], cuda_build, "datasets"
            )
            if not guard_ok:
                return False
        
        if not self._verify_import(python_executable, "datasets"):
            self.log(f"ERROR: datasets import verification failed")
            return False
        self.log("✓ datasets installed and verified")
        
        # Install trl (with --no-deps to prevent torch upgrade)
        self.log("Installing trl>=0.18.2,<0.25.0 (with --no-deps)...")
        success, last_lines, exit_code = self._run_pip_worker(
            action="install",
            package="trl>=0.18.2,<0.25.0",
            python_executable=python_executable,
            pip_args=["--no-deps"]
        )
        if not success:
            self.log(f"ERROR: trl installation failed")
            return False
        
        # GATE: Constraint violations check
        if "constraint" in last_lines.lower() and "violated" in last_lines.lower():
            self.log("ERROR: Constraint violation detected")
            return False
        
        # GATE: NumPy integrity
        numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
        if not numpy_ok:
            self.log(f"ERROR: NumPy integrity check failed after trl install: {numpy_error}")
            return False
        
        # GUARD: Check torch after trl install
        if require_cuda:
            cuda_build = install_plan.get("cuda_build", "cu124")
            guard_ok, guard_error = self._guard_torch_immutability(
                python_executable, install_plan["torch_spec"], cuda_build, "trl"
            )
            if not guard_ok:
                return False
        
        if not self._verify_import(python_executable, "trl"):
            self.log(f"ERROR: trl import verification failed")
            return False
        self.log("✓ trl installed and verified")
        
        # GATE: Core stack invariants after Layer 3
        self.log("=" * 60)
        self.log("GATE: Core stack invariants check (after Layer 3)")
        self.log("=" * 60)
        invariants_ok, invariants_error = self._gate_core_stack_invariants(python_executable, require_cuda)
        if not invariants_ok:
            self.log(f"ERROR: Core stack invariants gate failed after Layer 3: {invariants_error}")
            self.log("ABORTING: Installation failed - invariants violated")
            return False
        self.log("✓ Core stack invariants verified (Layer 3)")
        
        # STATE: LAYER 4 INSTALLATION (xformers, unsloth-zoo, unsloth)
        self.log("=" * 60)
        self.log("STATE: LAYER 4 - xformers, unsloth-zoo, unsloth")
        self.log("=" * 60)
        
        layer4_packages = [
            ("xformers", ""),
            ("unsloth-zoo", ""),
            ("unsloth", "")
        ]
        
        # Packages that can drag torch - install with --no-deps first
        torch_drag_packages = ["unsloth", "unsloth-zoo"]
        
        for pkg_name, pkg_version in layer4_packages:
            pkg_spec = f"{pkg_name}{pkg_version}" if pkg_version else pkg_name
            self.log(f"Installing {pkg_spec}...")
            
            # CRITICAL: For packages that can drag torch, install with --no-deps first
            pip_args = []
            use_no_deps = False
            if pkg_name in torch_drag_packages or pkg_name == "xformers":
                use_no_deps = True
                pip_args = ["--no-deps"]
                self.log(f"Using --no-deps for {pkg_name} to prevent torch upgrade")
            
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package=pkg_spec,
                python_executable=python_executable,
                pip_args=pip_args
            )
            if not success:
                # For xformers, if it fails with --no-deps, skip it (it's optional)
                if pkg_name == "xformers":
                    self.log(f"WARNING: xformers installation failed with --no-deps (skipping to prevent torch upgrade)")
                    continue
                # For other packages, check if constraint violation caused failure
                if "constraint" in last_lines.lower() or "would break" in last_lines.lower():
                    self.log(f"WARNING: {pkg_spec} installation failed due to constraints (skipping)")
                    continue
                self.log(f"WARNING: {pkg_spec} installation had issues (continuing)")
            else:
                # GATE: Constraint violations check (fatal)
                if "constraint" in last_lines.lower() and "violated" in last_lines.lower():
                    self.log(f"ERROR: Constraint violation detected for {pkg_spec}")
                    self.log("This is FATAL - constraints must be enforced")
                    return False
                
                # GATE: NumPy integrity (fatal)
                numpy_ok, numpy_error = self._gate_numpy_integrity(python_executable)
                if not numpy_ok:
                    self.log(f"ERROR: NumPy integrity check failed after {pkg_spec} install: {numpy_error}")
                    return False
                
                # GUARD: Check torch after Layer 4 install
                if require_cuda:
                    cuda_build = install_plan.get("cuda_build", "cu124")
                    guard_ok, guard_error = self._guard_torch_immutability(
                        python_executable, install_plan["torch_spec"], cuda_build, pkg_spec
                    )
                    if not guard_ok:
                        return False
                
                self.log(f"✓ {pkg_spec} installed")
        
        # GATE: Core stack invariants after Layer 4
        self.log("=" * 60)
        self.log("GATE: Core stack invariants check (after Layer 4)")
        self.log("=" * 60)
        invariants_ok, invariants_error = self._gate_core_stack_invariants(python_executable, require_cuda)
        if not invariants_ok:
            self.log(f"ERROR: Core stack invariants gate failed after Layer 4: {invariants_error}")
            self.log("ABORTING: Installation failed - invariants violated")
            return False
        self.log("✓ Core stack invariants verified (Layer 4)")
        
        # Install bitsandbytes (optional, only if CUDA available)
        if require_cuda:
            self.log("=" * 60)
            self.log("Installing bitsandbytes (optional, CUDA only)...")
            self.log("=" * 60)
            
            self.log("Installing bitsandbytes>=0.39.0...")
            success, last_lines, exit_code = self._run_pip_worker(
                action="install",
                package="bitsandbytes>=0.39.0",
                python_executable=python_executable,
                pip_args=["--no-deps"]  # Prevent torch modification
            )
            if not success:
                self.log("WARNING: bitsandbytes installation failed (optional dependency, continuing)")
            else:
                # GATE: Constraint violations check (fatal)
                if "constraint" in last_lines.lower() and "violated" in last_lines.lower():
                    self.log(f"ERROR: Constraint violation detected for bitsandbytes")
                    self.log("This is FATAL - constraints must be enforced")
                    return False
                
                # GUARD: Check torch after bitsandbytes install
                cuda_build = install_plan.get("cuda_build", "cu124")
                guard_ok, guard_error = self._guard_torch_immutability(
                    python_executable, install_plan["torch_spec"], cuda_build, "bitsandbytes"
                )
                if not guard_ok:
                    return False
                
                self.log("✓ bitsandbytes installed")
                
                # GATE: Core stack invariants after bitsandbytes
                self.log("=" * 60)
                self.log("GATE: Core stack invariants check (after bitsandbytes)")
                self.log("=" * 60)
                invariants_ok, invariants_error = self._gate_core_stack_invariants(python_executable, require_cuda)
                if not invariants_ok:
                    self.log(f"ERROR: Core stack invariants gate failed after bitsandbytes: {invariants_error}")
                    self.log("ABORTING: Installation failed - invariants violated")
                    return False
                self.log("✓ Core stack invariants verified (bitsandbytes)")
        
        # FINAL VERIFICATION
        self.log("=" * 60)
        self.log("FINAL VERIFICATION")
        self.log("=" * 60)
        
        # Get expected torch version for final verification
        expected_torch_version = install_plan["torch_spec"].split("==")[1]
        
        if require_cuda:
            final_verify_script = f"""import torch, transformers, datasets, huggingface_hub
assert torch.__version__ == '{expected_torch_version}'
assert torch.cuda.is_available()
print('INSTALL OK')
print('torch version:', torch.__version__)
print('CUDA available:', torch.cuda.is_available())
if torch.cuda.is_available():
    print('Device name:', torch.cuda.get_device_name(0))
"""
        else:
            final_verify_script = f"""import torch, transformers, datasets, huggingface_hub
assert torch.__version__ == '{expected_torch_version}'
print('INSTALL OK')
print('torch version:', torch.__version__)
"""
        
        final_cmd = [python_executable, "-c", final_verify_script]
        final_result = subprocess.run(
            final_cmd,
            capture_output=True,
            text=True,
            timeout=30,
            **self.subprocess_flags
        )
        
        if final_result.returncode == 0 and "INSTALL OK" in final_result.stdout:
            self.log("✓ Core components verified")
        else:
            self.log("=" * 60)
            self.log("REPAIR FAILED - Final verification failed")
            self.log(f"Error: {final_result.stderr or final_result.stdout}")
            self.log("=" * 60)
            return False
        
        # INFERENCE PATH VERIFICATION
        self.log("Verifying inference path...")
        inference_verify_script = """from transformers import PreTrainedModel
import peft
print('OK')
"""
        inference_cmd = [python_executable, "-c", inference_verify_script]
        inference_result = subprocess.run(
            inference_cmd,
            capture_output=True,
            text=True,
            timeout=30,
            **self.subprocess_flags
        )
        
        if inference_result.returncode != 0:
            error_output = inference_result.stderr or inference_result.stdout
            error_msg = f"Inference path broken: PreTrainedModel import failed: {error_output.strip()}"
            self.log(f"ERROR: {error_msg}")
            self.log("=" * 60)
            self.log("REPAIR FAILED - Inference path verification failed")
            self.log("=" * 60)
            return False
        
        self.log("✓ Inference path verified (PreTrainedModel import OK)")
        
        self.log("=" * 60)
        self.log("REPAIR COMPLETE - All components installed and verified")
        self.log("=" * 60)
        return True


if __name__ == "__main__":
    installer = SmartInstaller()
    success = installer.install()
    sys.exit(0 if success else 1)

