#!/usr/bin/env python3
"""
System Detection Module for LLM Fine-tuning Studio
Detects Python, PyTorch, CUDA, Visual C++ Redistributables, and hardware capabilities
"""

import os
import sys
import platform
import subprocess
import json
import time
import re
from pathlib import Path
from typing import Dict, Optional, List, Tuple
from datetime import datetime

class SystemDetector:
    """Detects system components and hardware capabilities"""
    
    def __init__(self):
        self.platform = platform.system().lower()
        self.detection_results = {}
        
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
    
    def _log_cuda_detection(self, result: Dict, success: bool):
        """Log CUDA detection attempts to logs/cuda_detection.log"""
        try:
            # Ensure logs directory exists
            log_dir = Path(__file__).parent / "logs"
            log_dir.mkdir(exist_ok=True)
            log_file = log_dir / "cuda_detection.log"
            
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            status = "SUCCESS" if success else "FAILED"
            
            log_entry = f"[{timestamp}] {status} - "
            
            if success:
                log_entry += f"Found: {result.get('found', False)}, "
                log_entry += f"Available: {result.get('available', False)}, "
                log_entry += f"GPUs: {len(result.get('gpus', []))}, "
                log_entry += f"Version: {result.get('version', 'N/A')}, "
                log_entry += f"Driver: {result.get('driver_version', 'N/A')}, "
                log_entry += f"Methods: {', '.join(result.get('detection_methods', []))}"
            else:
                log_entry += f"Error: {result.get('error', 'Unknown error')}"
                if result.get('warnings'):
                    log_entry += f", Warnings: {len(result['warnings'])}"
            
            # Append to log file
            with open(log_file, 'a', encoding='utf-8') as f:
                f.write(log_entry + "\n")
                if result.get('warnings'):
                    for warning in result['warnings']:
                        f.write(f"  WARNING: {warning}\n")
                if result.get('error'):
                    f.write(f"  ERROR: {result['error']}\n")
        except Exception:
            pass  # Don't fail detection if logging fails
    
    def detect_all(self) -> Dict:
        """Run all detection methods and return results"""
        results = {
            "python": self.detect_python(),
            "pytorch": self.detect_pytorch(),
            "cuda": self.detect_cuda(),
            "hardware": self.detect_hardware(),
            "vcredist": self.detect_vcredist() if self.platform == "windows" else None,
            "recommendations": {}
        }
        
        # Generate recommendations
        results["recommendations"] = self.get_recommendations(results)
        
        self.detection_results = results
        return results
    
    def detect_python(self) -> Dict:
        """Detect Python installation"""
        result = {
            "found": False,
            "version": None,
            "path": None,
            "executable": None,
            "pip_available": False
        }
        
        try:
            # Check current Python
            if sys.executable:
                try:
                    version = sys.version_info
                    result["found"] = True
                    result["version"] = f"{version.major}.{version.minor}.{version.micro}"
                    result["executable"] = sys.executable
                    result["path"] = os.path.dirname(sys.executable)
                    
                    # Check pip
                    try:
                        import pip
                        result["pip_available"] = True
                    except ImportError:
                        # Try running pip command
                        try:
                            subprocess.run([sys.executable, "-m", "pip", "--version"], 
                                          capture_output=True, check=True, timeout=5, **self.subprocess_flags)
                            result["pip_available"] = True
                        except:
                            pass
                except Exception as e:
                    pass
            
            # If not found, check common paths
            if not result["found"]:
                if self.platform == "windows":
                    common_paths = [
                        r"C:\Python*",
                        r"C:\Program Files\Python*",
                        r"C:\Program Files (x86)\Python*",
                        os.path.expanduser(r"~\AppData\Local\Programs\Python\Python*")
                    ]
                    # Also check PATH
                    path_dirs = os.environ.get("PATH", "").split(os.pathsep)
                    for path_dir in path_dirs:
                        python_exe = os.path.join(path_dir, "python.exe")
                        if os.path.exists(python_exe):
                            try:
                                version_output = subprocess.run(
                                    [python_exe, "--version"],
                                    capture_output=True, text=True, timeout=5, **self.subprocess_flags
                                )
                                if version_output.returncode == 0:
                                    version_str = version_output.stdout.strip()
                                    result["found"] = True
                                    result["executable"] = python_exe
                                    result["path"] = path_dir
                                    # Extract version
                                    import re
                                    match = re.search(r"(\d+)\.(\d+)\.(\d+)", version_str)
                                    if match:
                                        result["version"] = f"{match.group(1)}.{match.group(2)}.{match.group(3)}"
                                    break
                            except:
                                continue
                
                elif self.platform in ["linux", "darwin"]:
                    # Try common commands
                    for cmd in ["python3", "python"]:
                        try:
                            version_output = subprocess.run(
                                [cmd, "--version"],
                                capture_output=True, text=True, timeout=5, **self.subprocess_flags
                            )
                            if version_output.returncode == 0:
                                which_output = subprocess.run(
                                    ["which", cmd],
                                    capture_output=True, text=True, timeout=5, **self.subprocess_flags
                                )
                                if which_output.returncode == 0:
                                    result["found"] = True
                                    result["executable"] = which_output.stdout.strip()
                                    result["path"] = os.path.dirname(result["executable"])
                                    version_str = version_output.stdout.strip()
                                    import re
                                    match = re.search(r"(\d+)\.(\d+)\.(\d+)", version_str)
                                    if match:
                                        result["version"] = f"{match.group(1)}.{match.group(2)}.{match.group(3)}"
                                    
                                    # Check pip
                                    try:
                                        subprocess.run([result["executable"], "-m", "pip", "--version"],
                                                     capture_output=True, check=True, timeout=5, **self.subprocess_flags)
                                        result["pip_available"] = True
                                    except:
                                        pass
                                    break
                        except:
                            continue
            
            return result
        except Exception as e:
            import traceback
            from pathlib import Path
            log_dir = Path(__file__).parent.parent / ".cursor"
            log_dir.mkdir(parents=True, exist_ok=True)
            try:
                with (log_dir / "debug.log").open("a", encoding="utf-8") as log_file:
                    import json
                    import time
                    log_file.write(json.dumps({"id": f"log_{int(time.time() * 1000)}_detect_python_error", "timestamp": int(time.time() * 1000), "location": "system_detector.py:89", "message": "Exception in detect_python", "data": {"error_type": type(e).__name__, "error_msg": str(e), "traceback": traceback.format_exc()}, "sessionId": "debug-session", "runId": "run1", "hypothesisId": "A"}) + "\n")
            except Exception:
                pass
            result["error"] = str(e)
            result["traceback"] = traceback.format_exc()
            return result
    
    def detect_pytorch(self) -> Dict:
        """Detect PyTorch installation"""
        result = {
            "found": False,
            "version": None,
            "cuda_available": False,
            "cuda_version": None,
            "device": "cpu"
        }
        
        try:
            try:
                import torch
                result["found"] = True
                result["version"] = torch.__version__
                
                # Check CUDA availability
                if torch.cuda.is_available():
                    result["cuda_available"] = True
                    result["cuda_version"] = torch.version.cuda
                    result["device"] = "cuda"
                else:
                    result["device"] = "cpu"
            except ImportError:
                # PyTorch not installed
                pass
            except Exception as e:
                # Error detecting PyTorch
                result["error"] = str(e)
            
            return result
        except Exception as e:
            import traceback
            from pathlib import Path
            log_dir = Path(__file__).parent.parent / ".cursor"
            log_dir.mkdir(parents=True, exist_ok=True)
            try:
                with (log_dir / "debug.log").open("a", encoding="utf-8") as log_file:
                    import json
                    import time
                    log_file.write(json.dumps({"id": f"log_{int(time.time() * 1000)}_detect_pytorch_error", "timestamp": int(time.time() * 1000), "location": "system_detector.py:192", "message": "Exception in detect_pytorch", "data": {"error_type": type(e).__name__, "error_msg": str(e), "traceback": traceback.format_exc()}, "sessionId": "debug-session", "runId": "run1", "hypothesisId": "A"}) + "\n")
            except Exception:
                pass
            result["error"] = str(e)
            result["traceback"] = traceback.format_exc()
            return result
    
    def _try_nvidia_smi(self, max_retries: int = 3) -> Tuple[Optional[subprocess.CompletedProcess], List[str]]:
        """Try nvidia-smi with retry logic and exponential backoff"""
        errors = []
        timeouts = [30, 20, 15]  # Decreasing timeouts for retries
        
        for attempt in range(max_retries):
            try:
                delay = 2 ** attempt  # Exponential backoff: 1s, 2s, 4s
                if attempt > 0:
                    time.sleep(delay)
                
                timeout = timeouts[min(attempt, len(timeouts) - 1)]
                nvidia_smi = subprocess.run(
                    ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
                    capture_output=True, text=True, timeout=timeout, **self.subprocess_flags
                )
                
                if nvidia_smi.returncode == 0:
                    return nvidia_smi, errors
                else:
                    error_msg = f"Attempt {attempt + 1}: nvidia-smi returned code {nvidia_smi.returncode}"
                    if nvidia_smi.stderr:
                        error_msg += f", stderr: {nvidia_smi.stderr[:200]}"
                    errors.append(error_msg)
                    
            except FileNotFoundError:
                errors.append(f"Attempt {attempt + 1}: nvidia-smi not found in PATH")
                return None, errors  # No point retrying if not found
            except subprocess.TimeoutExpired:
                errors.append(f"Attempt {attempt + 1}: nvidia-smi timed out after {timeout}s")
            except Exception as e:
                errors.append(f"Attempt {attempt + 1}: {type(e).__name__}: {str(e)[:200]}")
        
        return None, errors
    
    def _detect_cuda_via_nvidia_smi(self, result: Dict) -> bool:
        """Detect CUDA via nvidia-smi (primary method)"""
        nvidia_smi, errors = self._try_nvidia_smi(max_retries=3)
        
        if nvidia_smi is None:
            if errors:
                result.setdefault("warnings", []).extend(errors)
                result["error"] = f"nvidia-smi failed: {errors[-1]}"
            return False
        
        # Parse nvidia-smi output
        try:
            lines = nvidia_smi.stdout.strip().split('\n')
            if not lines or not lines[0].strip():
                result.setdefault("warnings", []).append("nvidia-smi returned empty output")
                return False
            
            for line in lines:
                if line.strip():
                    # Handle CSV parsing - may have quoted fields
                    parts = []
                    current_part = ""
                    in_quotes = False
                    for char in line:
                        if char == '"':
                            in_quotes = not in_quotes
                        elif char == ',' and not in_quotes:
                            parts.append(current_part.strip())
                            current_part = ""
                        else:
                            current_part += char
                    if current_part:
                        parts.append(current_part.strip())
                    
                    if len(parts) >= 3:
                        gpu_info = {
                            "name": parts[0].strip('"'),
                            "memory": parts[1].strip('"'),
                            "driver_version": parts[2].strip('"')
                        }
                        result["gpus"].append(gpu_info)
                        if not result["driver_version"]:
                            result["driver_version"] = parts[2].strip('"')
            
            if result["gpus"]:
                result["found"] = True
                result["available"] = True
                
                # Try to get CUDA version from nvidia-smi
                try:
                    cuda_version_cmd = subprocess.run(
                        ["nvidia-smi", "--query-gpu=cuda_version", "--format=csv,noheader"],
                        capture_output=True, text=True, timeout=10, **self.subprocess_flags
                    )
                    if cuda_version_cmd.returncode == 0 and cuda_version_cmd.stdout.strip():
                        cuda_ver_raw = cuda_version_cmd.stdout.strip().split('\n')[0].strip()
                        # Filter out "Not Supported" or similar messages
                        if cuda_ver_raw and not cuda_ver_raw.lower().startswith("not"):
                            result["version"] = cuda_ver_raw
                except Exception as e:
                    result.setdefault("warnings", []).append(f"Could not get CUDA version from nvidia-smi: {str(e)[:100]}")
                
                # Get compute capability for each GPU
                try:
                    compute_cmd = subprocess.run(
                        ["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
                        capture_output=True, text=True, timeout=10, **self.subprocess_flags
                    )
                    if compute_cmd.returncode == 0 and compute_cmd.stdout.strip():
                        compute_caps = compute_cmd.stdout.strip().split('\n')
                        for idx, cap in enumerate(compute_caps):
                            if idx < len(result["gpus"]):
                                result["gpus"][idx]["compute_capability"] = cap.strip()
                except Exception as e:
                    result.setdefault("warnings", []).append(f"Could not get compute capability: {str(e)[:100]}")
                
                # If CUDA version not detected but we have driver, that's still useful
                if not result.get("version") and result.get("driver_version"):
                    result.setdefault("warnings", []).append(
                        f"CUDA version detection failed, but driver {result['driver_version']} detected. "
                        "Installer will infer CUDA version from driver."
                    )
                
                return True
            else:
                result.setdefault("warnings", []).append("nvidia-smi returned no GPU information")
                return False
                
        except Exception as e:
            result.setdefault("warnings", []).append(f"Error parsing nvidia-smi output: {str(e)[:200]}")
            return False
    
    def _detect_cuda_via_pytorch(self, result: Dict) -> bool:
        """Detect CUDA via PyTorch (verification method)"""
        try:
            import torch
            if torch.cuda.is_available():
                if not result.get("found"):
                    result["found"] = True
                    result["available"] = True
                
                if torch.version.cuda:
                    if not result.get("version"):
                        result["version"] = torch.version.cuda
                    return True
        except ImportError:
            pass  # PyTorch not installed
        except Exception as e:
            result.setdefault("warnings", []).append(f"PyTorch CUDA check failed: {str(e)[:100]}")
        return False
    
    def _detect_cuda_via_filesystem(self, result: Dict) -> bool:
        """Detect CUDA toolkit via file system paths"""
        found_toolkit = False
        
        if self.platform == "windows":
            cuda_paths = [
                r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA",
                r"C:\Program Files (x86)\NVIDIA GPU Computing Toolkit\CUDA"
            ]
            for base_path in cuda_paths:
                if os.path.exists(base_path):
                    try:
                        versions = [d for d in os.listdir(base_path) 
                                   if os.path.isdir(os.path.join(base_path, d)) and 
                                   re.match(r'^\d+\.\d+$', d)]
                        if versions:
                            versions.sort(key=lambda x: [int(i) for i in x.split('.')], reverse=True)
                            result["version"] = versions[0]
                            result["toolkit_path"] = os.path.join(base_path, versions[0])
                            found_toolkit = True
                            break
                    except Exception as e:
                        result.setdefault("warnings", []).append(f"Error scanning CUDA path {base_path}: {str(e)[:100]}")
        
        elif self.platform == "linux":
            cuda_paths = ["/usr/local/cuda", "/usr/lib/cuda"]
            for cuda_path in cuda_paths:
                if os.path.exists(cuda_path):
                    result["toolkit_path"] = cuda_path
                    version_file = os.path.join(cuda_path, "version.txt")
                    if os.path.exists(version_file):
                        try:
                            with open(version_file, 'r') as f:
                                content = f.read()
                                match = re.search(r"CUDA Version (\d+\.\d+)", content)
                                if match:
                                    result["version"] = match.group(1)
                                    found_toolkit = True
                        except Exception as e:
                            result.setdefault("warnings", []).append(f"Error reading CUDA version file: {str(e)[:100]}")
        
        elif self.platform == "darwin":  # macOS
            cuda_path = "/usr/local/cuda"
            if os.path.exists(cuda_path):
                result["toolkit_path"] = cuda_path
                found_toolkit = True
        
        if found_toolkit and not result.get("found"):
            result["found"] = True
            # Don't set available=True unless we have actual GPUs
        
        return found_toolkit
    
    def _detect_cuda_via_registry(self, result: Dict) -> bool:
        """Detect NVIDIA drivers via Windows registry"""
        if self.platform != "windows":
            return False
        
        try:
            import winreg
            reg_paths = [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\NVIDIA Corporation\Global\NVTweak"),
                (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Services\nvlddmkm"),
            ]
            
            for hkey, path in reg_paths:
                try:
                    key = winreg.OpenKey(hkey, path)
                    winreg.CloseKey(key)
                    if not result.get("found"):
                        result["found"] = True
                    return True
                except FileNotFoundError:
                    continue
                except Exception:
                    continue
        except ImportError:
            pass  # winreg not available
        except Exception as e:
            result.setdefault("warnings", []).append(f"Registry check failed: {str(e)[:100]}")
        
        return False
    
    def detect_cuda(self) -> Dict:
        """Detect CUDA installation and GPU hardware with multiple methods and retry logic"""
        result = {
            "found": False,
            "available": False,
            "version": None,
            "driver_version": None,
            "gpus": [],
            "toolkit_path": None,
            "warnings": [],
            "detection_methods": [],
            "detection_timestamp": datetime.now().isoformat()
        }
        
        try:
            # Method 1: nvidia-smi (primary, most reliable)
            if self._detect_cuda_via_nvidia_smi(result):
                result["detection_methods"].append("nvidia-smi")
            
            # Method 2: PyTorch CUDA check (verification)
            if self._detect_cuda_via_pytorch(result):
                result["detection_methods"].append("pytorch")
            
            # Method 3: File system detection (fallback)
            if self._detect_cuda_via_filesystem(result):
                result["detection_methods"].append("filesystem")
            
            # Method 4: Windows registry check (fallback)
            if self._detect_cuda_via_registry(result):
                result["detection_methods"].append("registry")
            
            # If we found CUDA toolkit but no GPUs, set available=False
            if result["found"] and not result["gpus"]:
                result["available"] = False
                if "nvidia-smi" not in result["detection_methods"]:
                    result.setdefault("warnings", []).append("CUDA toolkit found but no GPUs detected (nvidia-smi unavailable)")
            
            # Clean up empty warnings list
            if not result["warnings"]:
                del result["warnings"]
            
            # Log detection attempt
            success = result["found"] and result.get("available", False)
            self._log_cuda_detection(result, success)
            
            return result
        except Exception as e:
            import traceback
            from pathlib import Path
            log_dir = Path(__file__).parent.parent / ".cursor"
            log_dir.mkdir(parents=True, exist_ok=True)
            try:
                with (log_dir / "debug.log").open("a", encoding="utf-8") as log_file:
                    import json
                    import time
                    log_file.write(json.dumps({"id": f"log_{int(time.time() * 1000)}_detect_cuda_error", "timestamp": int(time.time() * 1000), "location": "system_detector.py:452", "message": "Exception in detect_cuda", "data": {"error_type": type(e).__name__, "error_msg": str(e), "traceback": traceback.format_exc()}, "sessionId": "debug-session", "runId": "run1", "hypothesisId": "A"}) + "\n")
            except Exception:
                pass
            result["error"] = str(e)
            result["traceback"] = traceback.format_exc()
            return result
    
    def verify_cuda_health(self) -> Dict:
        """Quick health check for CUDA - returns detailed status with recommendations"""
        health = {
            "status": "unknown",
            "healthy": False,
            "issues": [],
            "recommendations": [],
            "timestamp": datetime.now().isoformat()
        }
        
        # Quick nvidia-smi check
        nvidia_smi, errors = self._try_nvidia_smi(max_retries=1)  # Single quick attempt
        if nvidia_smi is None:
            health["status"] = "nvidia-smi_unavailable"
            health["issues"].append("nvidia-smi command failed or not found")
            health["recommendations"].append("Check if NVIDIA drivers are installed")
            health["recommendations"].append("Verify nvidia-smi is in PATH")
            if errors:
                health["issues"].extend(errors)
            return health
        
        # Quick PyTorch CUDA check
        try:
            import torch
            if torch.cuda.is_available():
                health["healthy"] = True
                health["status"] = "healthy"
                health["recommendations"].append("CUDA is working correctly")
            else:
                health["status"] = "pytorch_no_cuda"
                health["issues"].append("PyTorch installed but CUDA not available")
                health["recommendations"].append("Reinstall PyTorch with CUDA support")
        except ImportError:
            health["status"] = "pytorch_not_installed"
            health["issues"].append("PyTorch not installed")
            health["recommendations"].append("Install PyTorch with CUDA support")
        except Exception as e:
            health["status"] = "pytorch_error"
            health["issues"].append(f"PyTorch error: {str(e)[:100]}")
        
        # If nvidia-smi works but PyTorch doesn't see CUDA
        if nvidia_smi.returncode == 0 and not health["healthy"]:
            health["status"] = "driver_mismatch"
            health["issues"].append("GPU drivers work but PyTorch cannot access CUDA")
            health["recommendations"].append("Reinstall PyTorch with matching CUDA version")
        
        return health
    
    def get_gpu_memory_usage(self) -> List[Dict]:
        """Get current GPU memory usage for all detected GPUs"""
        result = []
        try:
            nvidia_smi = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5, **self.subprocess_flags
            )
            if nvidia_smi.returncode == 0:
                lines = nvidia_smi.stdout.strip().split('\n')
                for line in lines:
                    if line.strip():
                        parts = line.split(',')
                        if len(parts) >= 2:
                            used = float(parts[0].strip())
                            total = float(parts[1].strip())
                            result.append({
                                "used_mb": used,
                                "total_mb": total,
                                "percentage": round((used / total) * 100, 1) if total > 0 else 0
                            })
        except:
            pass
        return result

    def detect_hardware(self) -> Dict:
        """Detect hardware capabilities"""
        result = {
            "cpu_name": None,  # Add top-level cpu_name for easy access
            "cpu": {
                "cores": None,
                "architecture": platform.machine(),
                "processor": platform.processor()
            },
            "gpu": {
                "found": False,
                "vendor": None,
                "model": None,
                "memory_gb": None
            },
            "ram_gb": None,
            "disk_space_gb": None
        }
        
        try:
            # Get CPU name/processor info
            try:
                if self.platform == "windows":
                    # Use WMI to get actual CPU name on Windows
                    try:
                        cpu_cmd = subprocess.run(
                            ["wmic", "cpu", "get", "name"],
                            capture_output=True, text=True, timeout=5, **self.subprocess_flags
                        )
                        if cpu_cmd.returncode == 0:
                            lines = [line.strip() for line in cpu_cmd.stdout.strip().split('\n') if line.strip()]
                            # First line is "Name", second is the actual CPU name
                            if len(lines) > 1 and lines[1]:
                                result["cpu_name"] = lines[1]
                            elif len(lines) > 0 and lines[0] and lines[0] != "Name":
                                result["cpu_name"] = lines[0]
                            else:
                                result["cpu_name"] = platform.processor()
                        else:
                            result["cpu_name"] = platform.processor()
                    except Exception as e:
                        # Fallback to platform.processor() on error
                        result["cpu_name"] = platform.processor() or "Unknown CPU"
                else:
                    processor = platform.processor()
                    if processor:
                        result["cpu_name"] = processor
                    else:
                        # Fallback to cores + architecture
                        cores = os.cpu_count()
                        arch = platform.machine()
                        result["cpu_name"] = f"{cores}-core {arch}"
            except Exception as e:
                result["cpu_name"] = f"Unknown (error: {str(e)[:30]})"
            
            # CPU cores
            try:
                if self.platform == "windows":
                    result["cpu"]["cores"] = os.cpu_count()
                else:
                    result["cpu"]["cores"] = os.cpu_count()
            except:
                pass
            
            # RAM
            try:
                if self.platform == "windows":
                    import ctypes
                    class MEMORYSTATUSEX(ctypes.Structure):
                        _fields_ = [
                            ("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                        ]
                    stat = MEMORYSTATUSEX()
                    stat.dwLength = ctypes.sizeof(stat)
                    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
                    result["ram_gb"] = round(stat.ullTotalPhys / (1024**3), 2)
                elif self.platform == "linux":
                    with open('/proc/meminfo', 'r') as f:
                        for line in f:
                            if line.startswith('MemTotal:'):
                                kb = int(line.split()[1])
                                result["ram_gb"] = round(kb / (1024**2), 2)
                                break
                elif self.platform == "darwin":
                    mem_output = subprocess.run(
                        ["sysctl", "-n", "hw.memsize"],
                        capture_output=True, text=True, timeout=5, **self.subprocess_flags
                    )
                    if mem_output.returncode == 0:
                        bytes = int(mem_output.stdout.strip())
                        result["ram_gb"] = round(bytes / (1024**3), 2)
            except:
                pass
            
            # GPU (from CUDA detection or system)
            cuda_info = self.detect_cuda()
            if cuda_info["found"] and cuda_info["gpus"]:
                gpu = cuda_info["gpus"][0]
                result["gpu"]["found"] = True
                result["gpu"]["vendor"] = "NVIDIA"
                result["gpu"]["model"] = gpu.get("name", "Unknown")
                # Parse memory
                try:
                    mem_str = gpu.get("memory", "")
                    if "MiB" in mem_str:
                        mem_mib = int(mem_str.replace("MiB", "").strip())
                        result["gpu"]["memory_gb"] = round(mem_mib / 1024, 2)
                except:
                    pass
            
            # Disk space (check current directory)
            try:
                if self.platform == "windows":
                    import ctypes
                    free_bytes = ctypes.c_ulonglong(0)
                    ctypes.windll.kernel32.GetDiskFreeSpaceExW(
                        ctypes.c_wchar_p(os.getcwd()),
                        ctypes.pointer(ctypes.c_ulonglong()),
                        ctypes.pointer(ctypes.c_ulonglong()),
                        ctypes.pointer(free_bytes)
                    )
                    result["disk_space_gb"] = round(free_bytes.value / (1024**3), 2)
                else:
                    import shutil
                    stat = shutil.disk_usage(os.getcwd())
                    result["disk_space_gb"] = round(stat.free / (1024**3), 2)
            except:
                pass
            
            return result
        except Exception as e:
            import traceback
            from pathlib import Path
            log_dir = Path(__file__).parent.parent / ".cursor"
            log_dir.mkdir(parents=True, exist_ok=True)
            try:
                with (log_dir / "debug.log").open("a", encoding="utf-8") as log_file:
                    import json
                    import time
                    log_file.write(json.dumps({"id": f"log_{int(time.time() * 1000)}_detect_hardware_error", "timestamp": int(time.time() * 1000), "location": "system_detector.py:594", "message": "Exception in detect_hardware", "data": {"error_type": type(e).__name__, "error_msg": str(e), "traceback": traceback.format_exc()}, "sessionId": "debug-session", "runId": "run1", "hypothesisId": "A"}) + "\n")
            except Exception:
                pass
            result["error"] = str(e)
            result["traceback"] = traceback.format_exc()
            return result
    
    def detect_vcredist(self) -> Dict:
        """Detect Visual C++ Redistributables (Windows only)"""
        result = {
            "found": False,
            "versions": [],
            "required_dlls": {
                "msvcp140.dll": False,
                "vcruntime140.dll": False
            }
        }
        
        if self.platform != "windows":
            return result
        
        try:
            import winreg
            
            # Check registry for installed versions
            reg_paths = [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\VisualStudio"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\VisualStudio"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            ]
            
            for hkey, path in reg_paths:
                try:
                    key = winreg.OpenKey(hkey, path)
                    try:
                        i = 0
                        while True:
                            try:
                                subkey_name = winreg.EnumKey(key, i)
                                if "VC" in subkey_name or "Visual C++" in subkey_name or "vcredist" in subkey_name.lower():
                                    result["versions"].append(subkey_name)
                                    result["found"] = True
                                i += 1
                            except WindowsError:
                                break
                    finally:
                        winreg.CloseKey(key)
                except FileNotFoundError:
                    continue
                except Exception:
                    continue
            
            # Check for required DLLs in system directories
            system_dirs = [
                os.path.join(os.environ.get("SYSTEMROOT", "C:\\Windows"), "System32"),
                os.path.join(os.environ.get("SYSTEMROOT", "C:\\Windows"), "SysWOW64"),
            ]
            
            for dll_name in result["required_dlls"].keys():
                for sys_dir in system_dirs:
                    dll_path = os.path.join(sys_dir, dll_name)
                    if os.path.exists(dll_path):
                        result["required_dlls"][dll_name] = True
                        result["found"] = True
                        break
        
        except Exception as e:
            result["error"] = str(e)
        
        return result
    
    def get_recommendations(self, detection_results: Dict) -> Dict:
        """Generate installation recommendations based on detection"""
        recommendations = {
            "python": "use_existing" if detection_results["python"]["found"] else "install",
            "pytorch": "install",
            "pytorch_build": "cpu",
            "vcredist": "install" if (self.platform == "windows" and 
                                     not detection_results.get("vcredist", {}).get("found", False)) else "skip"
        }
        
        # Determine PyTorch build recommendation
        cuda_info = detection_results.get("cuda", {})
        hardware_info = detection_results.get("hardware", {})
        pytorch_info = detection_results.get("pytorch", {})
        
        # Check if CUDA is available in PyTorch (most reliable)
        if pytorch_info.get("cuda_available"):
            cuda_version = pytorch_info.get("cuda_version")
            if cuda_version:
                # Map CUDA version to PyTorch CUDA build
                major_version = cuda_version.split('.')[0]
                if major_version == "12":
                    recommendations["pytorch_build"] = "cu121"  # CUDA 12.1
                elif major_version == "11":
                    recommendations["pytorch_build"] = "cu118"  # CUDA 11.8
                else:
                    recommendations["pytorch_build"] = "cpu"
        # Fallback: Check CUDA detection and GPU
        elif cuda_info.get("found") and hardware_info.get("gpu", {}).get("found"):
            # CUDA detected but PyTorch doesn't have CUDA support
            # Check driver version to infer CUDA version
            driver_version = cuda_info.get("driver_version")
            if driver_version:
                try:
                    driver_major = int(driver_version.split('.')[0])
                    # Driver 560+ typically supports CUDA 12.x
                    if driver_major >= 560:
                        recommendations["pytorch_build"] = "cu121"
                    elif driver_major >= 520:
                        recommendations["pytorch_build"] = "cu118"
                    else:
                        recommendations["pytorch_build"] = "cpu"
                except:
                    recommendations["pytorch_build"] = "cu121"  # Default to latest
            else:
                recommendations["pytorch_build"] = "cu121"  # Default to latest CUDA
        else:
            recommendations["pytorch_build"] = "cpu"
        
        return recommendations


    def get_hardware_profile(self, selected_gpu_index: Optional[int] = None) -> Dict:
        """
        Get complete hardware profile for package selection.
        Returns all relevant hardware info in a structured format.
        
        Args:
            selected_gpu_index: Optional GPU index to use (for multi-GPU systems with user selection)
        """
        results = self.detect_all()
        
        cuda_info = results.get("cuda", {})
        hardware_info = results.get("hardware", {})
        python_info = results.get("python", {})
        
        # Determine best GPU (highest compute capability, then VRAM)
        # OR use user-selected GPU index if provided
        best_gpu = None
        if cuda_info.get("gpus"):
            if selected_gpu_index is not None and 0 <= selected_gpu_index < len(cuda_info["gpus"]):
                # User explicitly selected a GPU
                best_gpu = cuda_info["gpus"][selected_gpu_index]
                print(f"[HARDWARE] Using user-selected GPU index {selected_gpu_index}: {best_gpu.get('name', 'Unknown')}")
            else:
                # Auto-select: highest compute capability, then VRAM
                gpus_with_compute = [g for g in cuda_info["gpus"] if g.get("compute_capability")]
                if gpus_with_compute:
                    # Sort by compute capability (as float), then by VRAM
                    best_gpu = max(gpus_with_compute, key=lambda g: (
                        float(g.get("compute_capability", "0")),
                        self._parse_vram(g.get("memory", "0"))
                    ))
                else:
                    best_gpu = cuda_info["gpus"][0]  # Fallback to first GPU
        
        profile = {
            "cuda_version": cuda_info.get("version"),
            "cuda_driver_version": cuda_info.get("driver_version"),
            "compute_capability": best_gpu.get("compute_capability") if best_gpu else None,
            "gpu_model": best_gpu.get("name") if best_gpu else None,
            "vram_gb": self._parse_vram(best_gpu.get("memory")) if best_gpu else 0,
            "gpu_count": len(cuda_info.get("gpus", [])),
            "all_gpus": cuda_info.get("gpus", []),
            "cpu_arch": hardware_info.get("cpu", {}).get("architecture", "unknown"),
            "cpu_cores": hardware_info.get("cpu", {}).get("cores", 0),
            # detect_hardware() stores RAM at top-level "ram_gb"
            "ram_gb": hardware_info.get("ram_gb", 0) or 0,
            "os": sys.platform,
            "python_version": python_info.get("version", "unknown")
        }
        
        return profile
    
    def _parse_vram(self, memory_str: str) -> float:
        """Parse VRAM string like '24576 MiB' to GB float"""
        try:
            if not memory_str:
                return 0.0
            # Extract number
            import re
            match = re.search(r'(\d+)', str(memory_str))
            if match:
                mem_mb = int(match.group(1))
                return round(mem_mb / 1024.0, 1)  # Convert MiB to GB
        except:
            pass
        return 0.0


def detect_all() -> Dict:
    """Convenience function to run all detection"""
    detector = SystemDetector()
    return detector.detect_all()


if __name__ == "__main__":
    # Test detection
    detector = SystemDetector()
    results = detector.detect_all()
    print(json.dumps(results, indent=2))

