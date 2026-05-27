#!/usr/bin/env python3
"""
Installation Verification Module for LLM Fine-tuning Studio
Comprehensive checks to ensure all components are working correctly
"""

import sys
import subprocess
from pathlib import Path
from typing import Dict, Tuple, Optional
from importlib.metadata import PackageNotFoundError, version as pkg_version


def _safe_status_symbol(ok_symbol: str, fallback: str) -> str:
    """Return Unicode symbol when console encoding supports it, else ASCII fallback."""
    enc = (getattr(sys.stdout, "encoding", None) or "").lower()
    try:
        if enc and ok_symbol.encode(enc, errors="strict"):
            return ok_symbol
    except Exception:
        pass
    return fallback


def verify_python() -> Tuple[bool, str]:
    """Verify Python installation and version"""
    try:
        version = sys.version_info
        if version.major == 3 and version.minor >= 8:
            return True, f"Python {version.major}.{version.minor}.{version.micro}"
        else:
            return False, f"Python {version.major}.{version.minor} (requires 3.8+)"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_pytorch() -> Tuple[bool, str]:
    """Verify PyTorch installation and functionality"""
    try:
        # Ensure package metadata exists (prevents "torch imports but metadata missing" situations)
        try:
            _ = pkg_version("torch")
        except PackageNotFoundError:
            return False, "PyTorch is corrupted (no package metadata for torch)"

        import torch
        version = torch.__version__
        
        # Test basic tensor operations
        try:
            x = torch.rand(10, 10)
            y = x + x
            _ = y.sum()
            
            # Check CUDA availability
            cuda_available = torch.cuda.is_available()
            if cuda_available:
                device_name = torch.cuda.get_device_name(0)
                cuda_ver = torch.version.cuda if torch.version.cuda else "N/A"
                return True, f"PyTorch {version} with CUDA {cuda_ver} ({device_name})"

            # If a GPU exists but torch is CPU-only, treat as FAIL (training requires CUDA build)
            try:
                smi = subprocess.run(
                    ["nvidia-smi"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if smi.returncode == 0:
                    return False, f"PyTorch {version} is CPU-only but an NVIDIA GPU is detected"
            except Exception:
                pass

            return True, f"PyTorch {version} (CPU-only)"
                
        except Exception as e:
            return False, f"PyTorch {version} installed but tensor operations failed: {str(e)}"
            
    except ImportError:
        return False, "PyTorch not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_cuda() -> Tuple[bool, str]:
    """Verify CUDA availability and functionality"""
    try:
        import torch
        
        if not torch.cuda.is_available():
            return True, "No GPU (CPU-only mode)"
        
        # Test CUDA operations
        try:
            device_count = torch.cuda.device_count()
            device_name = torch.cuda.get_device_name(0)
            cuda_version = torch.version.cuda if torch.version.cuda else "N/A"
            
            # Test actual GPU tensor operation
            x = torch.rand(100, 100).cuda()
            y = x @ x.T
            _ = y.cpu()
            
            return True, f"{device_count} GPU(s): {device_name} (CUDA {cuda_version})"
            
        except Exception as e:
            return False, f"CUDA available but operations failed: {str(e)}"
            
    except ImportError:
        return False, "PyTorch not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_triton() -> Tuple[bool, str]:
    """Verify Triton installation and compatibility"""
    try:
        import triton
        version = triton.__version__

        # Windows uses triton-windows (module name is still 'triton'), versions are typically 3.5.x
        if sys.platform == "win32":
            return True, f"Triton {version} (Windows)"

        # Linux/macOS expectations
        if version.startswith("3.0"):
            return True, f"Triton {version} (compatible)"
        return True, f"Triton {version} (may have compatibility issues)"
            
    except ImportError:
        # Windows package name is triton-windows, but module is still triton; import error means missing anyway
        return False, "Triton not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_unsloth() -> Tuple[bool, str]:
    """Verify Unsloth installation"""
    try:
        import unsloth
        from unsloth import FastLanguageModel
        
        # Check version if available
        version = getattr(unsloth, "__version__", "Unknown")
        return True, f"Unsloth {version}"
        
    except ImportError as e:
        error_msg = str(e)
        if "AttrsDescriptor" in error_msg or "triton" in error_msg.lower():
            return False, "Unsloth import failed - Triton compatibility issue"
        else:
            return False, f"Unsloth not installed: {error_msg}"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_transformers() -> Tuple[bool, str]:
    """Verify Transformers library"""
    try:
        import transformers
        version = transformers.__version__
        return True, f"Transformers {version}"
    except ImportError:
        return False, "Transformers not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_datasets() -> Tuple[bool, str]:
    """Verify Datasets library"""
    try:
        import datasets
        version = datasets.__version__
        return True, f"Datasets {version}"
    except ImportError:
        return False, "Datasets not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_peft() -> Tuple[bool, str]:
    """Verify PEFT library"""
    try:
        import peft
        version = peft.__version__
        return True, f"PEFT {version}"
    except ImportError:
        return False, "PEFT not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_huggingface_hub() -> Tuple[bool, str]:
    """Verify Hugging Face Hub library"""
    try:
        import huggingface_hub
        version = huggingface_hub.__version__
        return True, f"Hugging Face Hub {version}"
    except ImportError:
        return False, "Hugging Face Hub not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_can_download() -> Tuple[bool, str]:
    """Verify ability to download from Hugging Face"""
    try:
        from huggingface_hub import HfApi
        
        # Try to connect to Hugging Face API
        api = HfApi()
        # Simple API call to check connectivity
        _ = api.list_models(limit=1)
        
        return True, "Hugging Face connection OK"
        
    except Exception as e:
        error_msg = str(e)
        if "connection" in error_msg.lower() or "network" in error_msg.lower():
            return False, "No internet connection or Hugging Face unreachable"
        else:
            return False, f"Error: {error_msg[:100]}"


def verify_pyside6() -> Tuple[bool, str]:
    """Verify PySide6 (GUI framework)"""
    try:
        import PySide6
        from PySide6.QtCore import __version__
        return True, f"PySide6 {__version__}"
    except ImportError:
        return False, "PySide6 not installed"
    except Exception as e:
        return False, f"Error: {str(e)}"


def verify_all() -> Tuple[bool, Dict[str, Tuple[bool, str]]]:
    """
    Run all verification checks
    Returns: (overall_success, detailed_results)
    """
    checks = {
        "Python": verify_python(),
        "PyTorch": verify_pytorch(),
        "CUDA": verify_cuda(),
        "Triton": verify_triton(),
        "Unsloth": verify_unsloth(),
        "Transformers": verify_transformers(),
        "Datasets": verify_datasets(),
        "PEFT": verify_peft(),
        "Hugging Face Hub": verify_huggingface_hub(),
        "HF Connection": verify_can_download(),
        "PySide6": verify_pyside6(),
    }
    
    # Critical components that must pass
    critical = ["Python", "PyTorch", "Transformers", "Hugging Face Hub", "PySide6"]
    
    # Check if all critical components passed
    overall_success = all(checks[comp][0] for comp in critical)
    
    return overall_success, checks


def print_verification_report(checks: Dict[str, Tuple[bool, str]]):
    """Print a formatted verification report"""
    print("\n" + "=" * 70)
    print("LLM Fine-tuning Studio - Installation Verification Report")
    print("=" * 70 + "\n")
    
    # Critical components
    print("CRITICAL COMPONENTS:")
    critical = ["Python", "PyTorch", "Transformers", "Hugging Face Hub", "PySide6"]
    for component in critical:
        if component in checks:
            success, message = checks[component]
            status = _safe_status_symbol("✓", "[OK]") if success else _safe_status_symbol("✗", "[FAIL]")
            print(f"  {status} {component:20s} {message}")
    
    print("\nOPTIONAL COMPONENTS:")
    optional = ["CUDA", "Triton", "Unsloth", "Datasets", "PEFT", "HF Connection"]
    for component in optional:
        if component in checks:
            success, message = checks[component]
            status = _safe_status_symbol("✓", "[OK]") if success else _safe_status_symbol("⚠", "[WARN]")
            print(f"  {status} {component:20s} {message}")
    
    print("\n" + "=" * 70)
    
    # Overall status
    critical_pass = all(checks[c][0] for c in critical if c in checks)
    if critical_pass:
        print(f"STATUS: {_safe_status_symbol('✓', '[OK]')} All critical components verified")
        
        # Check optional
        unsloth_ok = checks.get("Unsloth", (False, ""))[0]
        cuda_ok = checks.get("CUDA", (False, ""))[0]
        
        if not unsloth_ok:
            print("NOTE: Unsloth not working - training may fail")
        if not cuda_ok:
            print("NOTE: No GPU detected - training will be slow (CPU-only)")
    else:
        print(f"STATUS: {_safe_status_symbol('✗', '[FAIL]')} Critical components missing or broken")
        print("        Please run the first-time setup or check installation logs")
    
    print("=" * 70 + "\n")


def main():
    """Main entry point for verification script"""
    success, checks = verify_all()
    print_verification_report(checks)
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

