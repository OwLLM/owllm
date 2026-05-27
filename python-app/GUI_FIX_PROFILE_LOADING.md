# GUI Fix: Profile Requirements Loading & Refresh Button

## Date: January 6, 2025

## Problem
The Requirements tab wasn't showing version mismatches because `_get_profile_requirements()` was failing silently and falling back to requirements.txt instead of loading hardware-specific versions from the profile.

## Changes Made

### File: `LLM/desktop_app/main.py`

#### 1. Fixed `_get_profile_requirements()` (line 6074-6120)

**Added**:
- Proper sys.path handling to import core modules
- Path existence checking for compatibility_matrix.json
- Debug logging to console to see what's happening
- Detailed exception logging with traceback

```python
def _get_profile_requirements(self) -> dict:
    try:
        import sys
        from pathlib import Path
        
        # Add LLM directory to path if not already there
        llm_dir = Path(__file__).parent.parent
        if str(llm_dir) not in sys.path:
            sys.path.insert(0, str(llm_dir))
        
        from core.system_detector import SystemDetector
        from core.profile_selector import ProfileSelector
        
        # Detect hardware
        detector = SystemDetector()
        hw_profile = detector.get_hardware_profile()
        
        # Select profile
        compat_matrix_path = llm_dir / "metadata" / "compatibility_matrix.json"
        if not compat_matrix_path.exists():
            print(f"[GUI] Warning: compatibility_matrix.json not found")
            return {}
        
        selector = ProfileSelector(compat_matrix_path)
        profile_name, package_versions, warnings = selector.select_profile(hw_profile)
        
        print(f"[GUI] Loaded profile: {profile_name}")
        print(f"[GUI] Profile versions: {list(package_versions.keys())}")
        
        # Convert to requirement specs
        requirements = {}
        for pkg_name, version in package_versions.items():
            requirements[pkg_name] = f"=={version}"
        
        return requirements
    except Exception as e:
        print(f"[GUI] Failed to load profile requirements: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return {}
```

#### 2. Added Refresh Button (line 6202-6229)

Added a button at the top of the details panel to reload package status without restarting:

```python
refresh_btn = QPushButton("🔄 Refresh Status")
refresh_btn.setStyleSheet("""
    QPushButton {
        background: rgba(102, 126, 234, 0.2);
        color: #667eea;
        border: 1px solid rgba(102, 126, 234, 0.5);
        padding: 8px 16px;
        border-radius: 6px;
        font-weight: 600;
        font-size: 10pt;
    }
    QPushButton:hover {
        background: rgba(102, 126, 234, 0.3);
        border: 1px solid #667eea;
    }
""")
refresh_btn.clicked.connect(self._refresh_requirements_grid)
```

## Expected Result

After restart or clicking Refresh:

### Console Output
```
[GUI] Loaded profile: cuda121_ampere
[GUI] Profile versions: ['torch', 'transformers', 'peft', ...]
```

### GUI Display
```
transformers
Installed: 4.57.3
Required: ==4.51.3          ← From profile, not requirements.txt!
Status: WRONG VERSION       ← Orange badge
```

## Testing

1. **Restart the app** or click the new "🔄 Refresh Status" button
2. Check console output for "[GUI] Loaded profile" messages
3. Look at transformers card:
   - Should show `Required: ==4.51.3` (not `>=4.51.3,!=4.52.*`)
   - Should have orange "WRONG VERSION" badge
4. Click "Repair" - should now properly detect and fix version mismatch

## Benefits

- ✅ Hardware-adaptive requirements (different GPUs = different versions)
- ✅ Accurate version mismatch detection
- ✅ Debug logging to troubleshoot issues
- ✅ Refresh button for quick status updates
- ✅ No app restart needed to see changes
