# THE REAL BUG: Installer Using --no-deps Skipping Dependencies

## Root Cause Analysis

The installer GUI was showing packages as "Not Installed" because:

1. ✅ **GUI was checking the correct venv** (fixed in previous commit)
2. ❌ **BUT: torchvision CAN'T IMPORT because Pillow dependency is missing**
3. ❌ **Cause: Installer uses `--no-deps` flag which SKIPS installing dependencies**

### The --no-deps Problem

**File**: `LLM/core/immutable_installer.py` line 1094

```python
cmd = [
    str(venv_python), "-m", "pip", "install",
    "--no-index",  # Critical: offline only
    "--find-links", str(self.wheelhouse),
    "--no-cache-dir",
    "--no-deps",  # <-- THIS SKIPS DEPENDENCIES!
]
```

**What this means:**
- When installing `torchvision`, pip installs ONLY torchvision
- It IGNORES the dependency on `pillow` 
- Result: `import torchvision` fails with `ModuleNotFoundError: No module named 'PIL'`

### The Whitelist

Line 1156-1158 shows only SOME packages are allowed to install dependencies:

```python
packages_needing_deps = ["requests", "urllib3", "certifi", "charset-normalizer", 
                         "idna", "jinja2", "markupsafe", "peft", "tqdm", "colorama"]
```

**torchvision was NOT in this list!**

## The Fix

### 1. Added torchvision/torchaudio to dependency whitelist

**File**: `LLM/core/immutable_installer.py` line 1158

```python
packages_needing_deps = ["requests", "urllib3", "certifi", "charset-normalizer", 
                         "idna", "jinja2", "markupsafe", "peft", "tqdm", "colorama",
                         "torchvision", "torchaudio"]  # <-- ADDED
```

### 2. Added pillow to all hardware profiles

**Files**: All 5 profiles in `LLM/profiles/*.json`

Added `"pillow": ">=10.0.0,<12.0.0"` before torch in every profile:
- `turing_cu118.json`
- `ampere_cu121.json`
- `ada_cu124.json`
- `hopper_cu124.json`
- `blackwell_cu124.json`

### 3. Fixed GUI to check correct venv

**File**: `LLM/smart_installer.py` line 2426-2445

Changed to always use target venv (`LLM/.venv`) instead of bootstrap venv.

### 4. Removed mamba/causal from GUI checklist

These are OPTIONAL packages not in profiles - removed from GUI to avoid confusion.

### 5. Added error logging to GUI checks

**File**: `LLM/smart_installer.py`

Added stderr logging when package imports fail so we can diagnose issues.

## Why This Worked on Other PCs

The installer worked on other PCs because:
1. They probably had an existing Python environment with pillow already installed globally
2. Or they installed from scratch with an older version of the installer that didn't use `--no-deps`
3. Or the wheelhouse had pillow cached from a previous run

## Testing

To verify the fix, run a **Rebuild** (not Repair) to reinstall everything:

1. Open installer GUI
2. Click "Rebuild" button
3. Should now install:
   - torch (no deps needed)
   - torchvision **WITH pillow dependency**
   - torchaudio **WITH dependencies**
   - All other packages

4. After install, check:
   ```bash
   D:\1_GitHome\LLM-Studio\LLM\.venv\Scripts\python.exe -c "import torchvision; print(torchvision.__version__)"
   ```
   Should print: `0.20.1+cu118` (not error)

## Files Modified

1. `LLM/core/immutable_installer.py` - Added torchvision/torchaudio to packages_needing_deps
2. `LLM/profiles/turing_cu118.json` - Added pillow
3. `LLM/profiles/ampere_cu121.json` - Added pillow
4. `LLM/profiles/ada_cu124.json` - Added pillow
5. `LLM/profiles/hopper_cu124.json` - Added pillow
6. `LLM/profiles/blackwell_cu124.json` - Added pillow
7. `LLM/smart_installer.py` - Fixed venv detection, added error logging, removed mamba/causal

## Summary

The **source of truth** (profile JSON files) was correct all along. The problem was:
1. **The installer wasn't respecting dependencies** due to aggressive `--no-deps` usage
2. **Only whitelisted packages could install deps**, and torchvision wasn't whitelisted
3. **Missing dependency (pillow) caused import failures**, making GUI show "Not Installed"

After this fix, the installer will properly install dependencies for torchvision/torchaudio from the wheelhouse.
