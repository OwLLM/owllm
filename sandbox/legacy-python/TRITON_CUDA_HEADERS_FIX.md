# Triton CUDA Headers Installation Fix

## Problem
When installing Triton on Windows with CUDA support, users encountered compilation errors:
```
[ERROR] Model loading failed: Command '[...gcc...]' returned non-zero exit status 1.
fatal error: cuda.h: No such file or directory
```

This occurred because:
1. Triton needs CUDA headers (`cuda.h`) to compile CUDA code at runtime
2. PyTorch CUDA builds don't include CUDA headers by default
3. The installer didn't automatically install CUDA headers

## Solution
The installer now automatically:

1. **Detects CUDA version** from PyTorch installation
2. **Installs CUDA headers** via `nvidia-cuda-runtime-cuXX` package matching the CUDA version
3. **Patches triton's windows_utils.py** to improve CUDA detection (more lenient header checks)

## Changes Made

### 1. Added `_get_cuda_version_from_torch()` method
- Detects CUDA version from PyTorch (e.g., "12.1" from `torch.version.cuda`)

### 2. Added `_install_cuda_headers()` method
- Automatically installs `nvidia-cuda-runtime-cu12` or `nvidia-cuda-runtime-cu11` based on detected CUDA version
- Verifies headers are installed at expected location
- Handles errors gracefully with warnings

### 3. Added `_patch_triton_windows_utils()` method
- Fixes `find_winsdk_registry()` to return `(None, None)` instead of `None` on error
- Adds lenient CUDA header detection (checks for headers even if other components missing)
- Improves CUDA detection to support CUDA 11.x versions

### 4. Updated Triton installation flow
- Installs CUDA headers **before** installing Triton (if CUDA detected)
- Patches `windows_utils.py` **after** installing Triton
- Provides clear logging at each step

## Installation Flow

```
1. Verify PyTorch is installed with CUDA support
   ↓
2. Detect CUDA version (e.g., 12.1)
   ↓
3. Install nvidia-cuda-runtime-cu12==12.1.*
   ↓
4. Install triton-windows
   ↓
5. Patch triton/windows_utils.py with CUDA detection fixes
   ↓
6. Verify Triton installation
```

## User Impact

**Before:** Users had to manually:
- Debug compilation errors
- Find and install CUDA headers manually
- Patch triton code themselves

**After:** Installer handles everything automatically - users just run the installer and it works!

## Testing

To verify the fix works:
1. Install PyTorch with CUDA support
2. Run installer to install Triton
3. Check logs for "CUDA headers installed successfully"
4. Try loading a model that uses Triton - should work without compilation errors

## Additional Requirements

**Important:** CUDA headers alone are not sufficient. Triton also needs the CUDA library (`cuda.lib`) for linking.

### Option 1: Install Full CUDA Toolkit (Recommended)
The full CUDA Toolkit includes both headers and libraries:
1. Download from: https://developer.nvidia.com/cuda-downloads
2. Install the toolkit
3. Set `CUDA_PATH` environment variable (usually set automatically)

### Option 2: Use pip packages (may not include libraries)
```bash
# For CUDA 12.1
pip install nvidia-cuda-runtime-cu12==12.1.*
pip install nvidia-cuda-nvcc-cu12==12.1.*  # May include some libraries

# For CUDA 12.4
pip install nvidia-cuda-runtime-cu12==12.4.*
pip install nvidia-cuda-nvcc-cu12==12.4.*

# For CUDA 11.8
pip install nvidia-cuda-runtime-cu11==11.8.*
pip install nvidia-cuda-nvcc-cu11==11.8.*
```

**Note:** If you get `cannot find -lcuda` errors, you need to install the full CUDA Toolkit.

## Related Files

- `LLM/smart_installer.py` - Main installer with new methods
- `LLM/.venv/Lib/site-packages/triton/windows_utils.py` - Patched automatically during installation
