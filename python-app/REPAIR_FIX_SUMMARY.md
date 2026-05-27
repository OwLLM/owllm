# Repair System Fix - January 6, 2025

## Problem
The repair functionality was failing to fix broken packages, specifically when `peft` had an import error due to version incompatibility with `transformers`:

```
ImportError: cannot import name 'BloomPreTrainedModel' from 'transformers'
```

The repair system would detect the package as broken but then fail to properly reinstall it because:
1. It was using `--force-reinstall` which doesn't fully clean corrupted files
2. It wasn't actually uninstalling the broken package first
3. The broken package detection for `peft` wasn't comprehensive enough

## Root Cause
When packages have version compatibility issues (e.g., `peft 0.13.2` trying to import deprecated classes from `transformers 4.57.3`), using pip's `--force-reinstall` flag alone is insufficient because:
- Corrupted or incompatible package files may remain
- Pip may not properly clean up all old files
- The package metadata may indicate "installed" but the package is functionally broken

## Solution Implemented

### 1. Proper Uninstall Before Reinstall
**File**: `LLM/core/immutable_installer.py`

Changed the repair logic in `_install_packages()` method to:
- **Before**: Used `--upgrade --force-reinstall` flags
- **After**: Explicitly uninstall the broken package first using `pip uninstall -y`, then do a clean install

```python
elif is_broken:
    self.log(f"Package {pkg_name} is broken - will reinstall")
    # Force uninstall first, then reinstall
    self.log(f"  Uninstalling broken {pkg_name}...")
    self._uninstall_package(venv_python, pkg_name)
    # After uninstall, we'll do a clean install (no extra args needed)
    extra_reinstall_args = []
```

### 2. Added `_uninstall_package()` Method
Created a new method to properly uninstall packages:

```python
def _uninstall_package(self, venv_python: Path, package_name: str) -> Tuple[bool, str]:
    """Uninstall a package completely."""
    cmd = [str(venv_python), "-m", "pip", "uninstall", "-y", package_name]
    # ... run command and handle errors
```

### 3. Enhanced Directory Cleanup for Critical Packages
Added special cleanup for `peft` and `transformers` (in addition to existing `torch` and `triton` cleanup):

```python
# For peft/transformers, ensure clean reinstall if broken
elif pkg_name in ["peft", "transformers"]:
    self.log(f"  Cleaning up broken {pkg_name} installation...")
    pkg_path = self.venv_path / "Lib" / "site-packages" / pkg_name
    if pkg_path.exists():
        shutil.rmtree(pkg_path, ignore_errors=True)
```

### 4. Improved Broken Package Detection for `peft`
Enhanced the `_check_package_broken()` method to specifically detect the `BloomPreTrainedModel` import error:

```python
elif package_name == "peft":
    code = """
try:
    import peft
    from peft import LoraConfig, get_peft_model
    # Also check that peft can properly import from transformers
    from peft.utils.constants import TRANSFORMERS_MODELS_TO_LORA_TARGET_MODULES_MAPPING
    print('OK')
except ImportError as e:
    # Check if it's the BloomPreTrainedModel error or similar compatibility issue
    if 'BloomPreTrainedModel' in str(e) or 'cannot import name' in str(e):
        print('BROKEN')
    else:
        print('NOT_INSTALLED')
except Exception as e:
    print('BROKEN')
"""
```

## Changes Applied To
1. `LLM/core/immutable_installer.py`:
   - Modified `_install_packages()` method (2 locations: CUDA packages and core dependencies)
   - Added `_uninstall_package()` method
   - Enhanced `_check_package_broken()` for peft
   - Added cleanup logic for peft/transformers broken installations

## Benefits
1. **Self-Healing**: The repair system now properly detects and fixes broken packages
2. **No Manual Intervention**: Users don't need to manually uninstall packages
3. **Clean State**: Ensures corrupted files are completely removed before reinstall
4. **Better Detection**: More comprehensive checks for package functionality

## Testing
To test the fix:
1. Run the application
2. Go to Requirements page
3. Click "Repair" button on a broken package (or use the main Repair button)
4. The system should now:
   - Detect broken packages correctly
   - Uninstall them completely
   - Clean up their directories
   - Reinstall from wheelhouse
   - Verify functionality

## Notes
- The fix maintains the immutable installer philosophy (install from wheelhouse only)
- No changes to package versions in profiles (peft 0.13.2 should work with transformers 4.57.3 once properly installed)
- The fix applies to both CUDA packages and core dependencies
- Special cleanup is now applied to: `torch`, `triton`, `peft`, and `transformers`
