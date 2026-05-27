# Revert to Working GUI - Changes Summary

## Date: December 30, 2025

## Problem
Application was not starting properly after recent changes:
- Took 1+ minute to start
- Opened repair GUI unnecessarily (complaining about triton-windows and open-clip-torch)
- Center PNG not displaying correctly

## Solution
Reverted to the last known working version (commit `ee09167`) while keeping critical dependency fixes.

---

## Files Changed

### 1. `hybrid_frame_module/hybrid_frame_window.py`
**REVERTED to commit ee09167**

**Key Changes:**
- Simpler PNG rendering: Badge size based on corner size (dynamic, not fixed 300px height)
  - Badge width: `int(cs * 1.6)` ≈ 64px for 40px corners
  - Badge height: `int(cs * 0.65)` ≈ 26px for 40px corners
  - Position: `y = max(0, t // 2)` (centered in top border)
  
- Simpler content margins: Equal margins all around
  - `self._layout.setContentsMargins(m, m, m, m)`
  - No special top margin for PNG overhang
  
- Removed `top_png_overhang` variable (not needed)

- Restored `WA_TranslucentBackground` attribute

**Old (broken) version:**
```python
badge_h = 300  # Fixed 300px height
aspect_ratio = self.top_center.width() / self.top_center.height()
badge_w = int(badge_h * aspect_ratio)
x = (w - badge_w) // 2
y = t + 5
```

**New (working) version:**
```python
badge_h = int(cs * 0.65)
badge_w = int(cs * 1.6)
x = (w - badge_w) // 2
y = max(0, t // 2)
```

### 2. `LLM/desktop_app/main.py`
**Partially reverted frame initialization**

**Changed frame parameters (line ~5286):**
```python
# OLD (complex):
frame = HybridFrameWindow(assets, corner_size=40, border_thickness=6, resize_margin=5, safe_padding=0)

# NEW (simple):
frame = HybridFrameWindow(assets, corner_size=40, border_thickness=4, safe_padding=2)
```

**KEPT dependency fixes:**
- System detection still runs but doesn't auto-launch repair GUI
- triton-windows and open-clip-torch marked as optional

### 3. `LLM/requirements.txt`
**KEPT changes - no revert needed**
- timm, einops, open-clip-torch commented out as optional

### 4. `LLM/metadata/dependencies.json`
**KEPT changes - no revert needed**
- triton-windows removed from core_dependencies
- timm, einops, open-clip-torch removed from core_dependencies
- All moved to optional_packages section

### 5. `LLM/metadata/compatibility_matrix.json`
**KEPT changes - no revert needed**
- Moved optional vision packages to separate section

---

## Expected Behavior After Changes

✅ **Application starts quickly** (~5-10 seconds, not 1 minute)
✅ **GUI displays with center PNG** visible and properly sized
✅ **No automatic repair GUI popup** (unless truly critical packages are missing)
✅ **All tabs functional** (Home, Chat, Training, Models, etc.)
✅ **System detection runs in background** without blocking or triggering popups

---

## What Was NOT Changed

- Backend functionality (training, inference, model management)
- Database operations
- System detection logic (still runs, just doesn't auto-popup)
- Theme system and dark mode
- Chat widget and training widgets
- Model card widgets

---

## Technical Details

### Why the old version worked better:
1. **Simpler PNG rendering** - Dynamic sizing based on corner size instead of fixed 300px
2. **Simpler geometry** - Equal margins, no complex calculations for PNG overhang
3. **Lighter frame parameters** - border_thickness=4 instead of 6, safe_padding=2 instead of 0
4. **Proper attribute settings** - WA_TranslucentBackground set correctly

### Why we kept dependency fixes:
- triton-windows is genuinely optional (only for advanced GPU optimizations)
- open-clip-torch is genuinely optional (only for vision-language models)
- These were causing false-positive "missing dependency" errors

---

## Testing Checklist

After these changes, verify:
- [ ] App starts in < 15 seconds
- [ ] Center PNG (owl logo) visible at top
- [ ] No repair GUI appears on startup
- [ ] Home tab shows system info correctly
- [ ] Chat tab works
- [ ] Training tab works
- [ ] Models tab works
- [ ] Dark mode toggle works
- [ ] Window can be dragged and resized

---

## If Issues Persist

1. **Check the assets directory:**
   ```
   hybrid_frame_module/assets/top_center.png should exist
   ```

2. **Check console for errors:**
   - Look for import errors
   - Look for PySide6 version mismatches

3. **Try disabling hybrid frame:**
   ```bash
   set USE_HYBRID_FRAME=0
   python LLM/desktop_app/main.py
   ```

4. **Check Python environment:**
   - Verify PySide6 is installed and matches version requirements
   - Check that all critical packages are present (torch, transformers, etc.)

---

## Commit Reference

**Last working version:** `ee09167` (Dec 30, 2025)
**Changes applied from:** Revert plan executed Dec 30, 2025

