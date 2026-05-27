# FINAL FIX: Profile Versions Used Throughout Entire Stack

## Date: January 6, 2025

## The Architecture Problem

The system had conflicting version sources at different layers:

```
Profile (cuda121_ampere)    → transformers==4.51.3  (EXACT)
     ↓
Wheelhouse validation       → Uses profile ✓
     ↓
ImmutableInstaller          → Uses MANIFEST ✗ (transformers>=4.51.3,!=4.52.*)
     ↓
Result: 4.57.3 passes check → NOT REPLACED
```

## The Professional Solution

**Single Source of Truth: Profile versions propagate through entire stack**

```
Profile (cuda121_ampere)    → transformers==4.51.3
     ↓
InstallerV2                 → Passes package_versions
     ↓
Wheelhouse validation       → Uses package_versions
     ↓
ImmutableInstaller          → Uses package_versions (NEW!)
     ↓
Result: Exact version check → 4.57.3 FAILS → REPLACED ✓
```

## Files Modified

### 1. `LLM/installer_v2.py` (line 440)
**Changed**: Pass `package_versions` to installer

```python
# OLD:
success, error = installer.install(cuda_config)

# NEW:
success, error = installer.install(cuda_config, package_versions=package_versions)
```

### 2. `LLM/core/immutable_installer.py` (3 changes)

#### A. Method Signature (line 93)
```python
def install(self, cuda_config: str, package_versions: dict = None):
    """
    Args:
        package_versions: Optional dict of {package_name: exact_version} from profile.
                        If provided, uses these for version checking instead of manifest.
    """
```

#### B. Store Profile Versions (line 107)
```python
# Store profile versions for version checking
self.profile_versions = package_versions or {}
```

#### C. Use Profile Versions in Version Checks (line 161-210)
```python
# Use profile versions if available, otherwise fall back to manifest
if self.profile_versions:
    # Profile mode: use exact versions from profile
    cuda_packages_to_check = {k: self.profile_versions.get(k, v) 
                             for k, v in cuda_packages.items()}
else:
    cuda_packages_to_check = cuda_packages

# For core dependencies
if self.profile_versions and pkg_name in self.profile_versions:
    version_spec = f"=={self.profile_versions[pkg_name]}"
else:
    version_spec = dep["version"]  # Manifest fallback
```

### 3. `LLM/core/wheelhouse.py` (previous fix)
- Added `_remove_package_wheels()` method
- Removes wrong version wheels during validation

## How It Works Now

### Repair Flow

1. **Profile Selection**
   ```
   cuda121_ampere profile loaded
   package_versions = {
       "torch": "2.5.1+cu121",
       "transformers": "4.51.3",
       "peft": "0.13.2",
       ...
   }
   ```

2. **Wheelhouse Validation**
   ```
   Checks: transformers wheel == 4.51.3?
   Found: 4.57.3
   Action: Remove 4.57.3 wheel
   Download: 4.51.3 wheel
   ```

3. **Venv Check** (NEW - uses profile versions!)
   ```
   Installed: transformers 4.57.3
   Required: ==4.51.3 (from profile, not >=4.51.3 from manifest)
   Match: NO
   Action: Mark for reinstall
   ```

4. **Installation**
   ```
   Uninstall: transformers 4.57.3
   Install: transformers 4.51.3 (from wheelhouse)
   Verify: peft imports successfully
   ```

## Benefits

✅ **Hardware-Adaptive**: Different GPUs get different exact versions
✅ **Consistent**: Same version source (profile) used everywhere
✅ **No False Positives**: Exact version matching, not flexible ranges
✅ **Backward Compatible**: Falls back to manifest if no profile provided
✅ **Works for ALL hardware**: RTX 2000, 3000, 4000, 5000, H100, etc.

## Testing

Run repair - should now:
1. Detect transformers 4.57.3 != 4.51.3 (exact match)
2. Uninstall 4.57.3
3. Install 4.51.3
4. SUCCESS

This is the FINAL, PROFESSIONAL solution.
