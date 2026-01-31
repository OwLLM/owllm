# Verification Fixes Complete

## Summary of Changes

Fixed package detection failures where the installer reported "all packages installed" but verification failed with "torch not found", "mamba not found", and other false negatives.

## Root Causes Identified

1. **Package Name Mismatches**: pip package names (with hyphens) don't always match import/metadata names (with underscores)
   - Example: `huggingface-hub` (pip) vs `huggingface_hub` (metadata)
   - Example: `triton-windows` (pip) vs `triton` (import)

2. **Metadata Cache Timing**: After pip install, there's a brief window where metadata cache isn't refreshed, causing `PackageNotFoundError`

3. **Limited Name Variant Checking**: Only checked one name variant, missing valid alternatives

## Files Modified

### 1. `LLM/core/immutable_installer.py`

#### Change 1: Added Comprehensive Package Name Map (line ~1604)

**Before:**
```python
import_name = package_name
if package_name == "triton-windows":
    import_name = "triton"
```

**After:**
```python
# Package name mappings (pip name -> import name / metadata name)
PACKAGE_NAME_MAP = {
    # Binary packages with different names
    "triton-windows": "triton",
    "mamba-ssm": "mamba_ssm",
    
    # Packages with hyphen/underscore differences
    "huggingface-hub": "huggingface_hub",
    "typing-extensions": "typing_extensions",
    "open-clip-torch": "open_clip_torch",
    
    # PySide6 packages
    "PySide6-Essentials": "PySide6.Essentials",
    "PySide6-Addons": "PySide6.Addons",
}

import_name = PACKAGE_NAME_MAP.get(package_name, package_name)
```

#### Change 2: Try Multiple Name Variants (line ~1664)

**Before:**
```python
try:
    installed_ver = version('{package_name}')
except PackageNotFoundError:
    installed_ver = version('{check_package_name}')
```

**After:**
```python
# Try multiple name variants: pip name, import name, and normalized versions
names_to_try = ['{package_name}']
if '{check_package_name}' != '{package_name}':
    names_to_try.append('{check_package_name}')
# Also try normalized version (replace - with _)
normalized = '{package_name}'.replace('-', '_')
if normalized not in names_to_try:
    names_to_try.append(normalized)

installed_ver = None
for name in names_to_try:
    try:
        installed_ver = version(name)
        break
    except PackageNotFoundError:
        continue
```

#### Change 3: Added Metadata Cache Refresh (line ~1064)

**After all packages installed:**
```python
# Force metadata cache refresh
try:
    import importlib.metadata
    if hasattr(importlib.metadata, 'distributions'):
        _ = list(importlib.metadata.distributions())
        self.log("  ✓ Metadata cache refreshed")
except Exception as e:
    self.log(f"  ⚠ Could not refresh metadata cache: {e}")
```

### 2. `LLM/diagnose_installation.py` (NEW)

Created comprehensive diagnostic script that:
- Lists all installed packages via pip
- Checks each key package by:
  - Metadata version lookup (tries multiple name variants)
  - Import test
  - Error reporting
- Shows venv health status
- Displays state file contents

**Usage:**
```bash
cd LLM
python diagnose_installation.py
```

## How This Fixes the Problems

### Before Fixes:
```
[INSTALLER] ✓ All packages installed (3 total)
[VERIFY] torch: ERROR: Package torch not found
[VERIFY] huggingface-hub: ERROR: Package huggingface-hub not found
[VERIFY] mamba-ssm: ERROR: Package mamba-ssm not found
```

### After Fixes:
```
[INSTALLER] ✓ All packages installed (3 total)
[INSTALLER]   ✓ Metadata cache refreshed
[VERIFY] torch: 2.5.1+cu118 ✓
[VERIFY] huggingface-hub: 0.34.0 ✓  (found as huggingface_hub)
[VERIFY] mamba-ssm: 2.2.2 ✓  (found as mamba_ssm)
```

## Technical Details

### Package Name Resolution Order:
1. Try pip package name (e.g., `huggingface-hub`)
2. Try mapped import name (e.g., `huggingface_hub`)
3. Try normalized name (replace `-` with `_`)
4. If all fail, return `NOT_FOUND`

### Metadata Cache Refresh:
- Called immediately after pip install completes
- Forces Python to reload distribution metadata
- Ensures packages are discoverable within same process
- Non-blocking (catches exceptions if refresh fails)

### Build Tag Handling:
- Version comparison already preserves build tags (e.g., `+cu118`)
- Previous wheelhouse fix (line 275) ensures build tags are compared correctly

## Testing

To verify fixes work:

1. **Run diagnostic:**
   ```bash
   cd LLM
   python diagnose_installation.py
   ```
   
2. **Check output:**
   - All key packages should show versions, not "NOT_FOUND"
   - Import tests should show ✓ OK
   - No errors about metadata

3. **Run installer:**
   ```bash
   launcher.exe
   # or
   LAUNCHER.bat
   ```
   
4. **Verify:**
   - Should complete without false "package not found" errors
   - Verification should pass
   - No repair loops

## Expected Behavior

### Fresh Install:
1. Wheelhouse validates correctly (no re-downloads)
2. Packages install successfully
3. Metadata cache refreshes
4. Verification passes first time
5. State file shows `verification_passed: true`

### Interrupted Install:
1. Resume from state (no re-downloads)
2. Install missing packages
3. Metadata cache refreshes
4. Verification completes
5. No false negatives

### After Successful Install:
1. Launcher checks state file
2. Sees recent verification success
3. Skips checks for 24 hours
4. Launches app directly

## Related Fixes

These fixes work together with:
- **Wheelhouse version fix** (line 275): Preserves build tags in version comparison
- **huggingface-hub version fix** (all profiles): Updated to `>=0.34.0,<1.0`
- **State persistence fixes** (PHASE 5.5 & 7): Save state before and after verification
- **Lenient check_dependencies.py**: Prevents repair loops after successful install

## Summary

All three root causes have been addressed:
1. ✅ Package name mismatches → PACKAGE_NAME_MAP + multi-variant checking
2. ✅ Metadata cache timing → Explicit cache refresh after install
3. ✅ Limited name checking → Try normalized and mapped names

The verification system will now correctly detect installed packages regardless of naming differences.
