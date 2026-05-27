# Testing Guide for Self-Installing Universal Launcher

## Overview
This guide provides instructions for testing the LLM Fine-tuning Studio's self-installing launcher on various system configurations.

## Test Environments

### Environment 1: Clean Windows 11 (No Python)
**Purpose:** Test full installation from scratch

**Setup:**
- Fresh Windows 11 VM
- No Python installed
- No development tools installed

**Expected Behavior:**
1. User runs `LAUNCHER.bat`
2. System detects Python is missing
3. Setup wizard shows error message
4. User installs Python from python.org
5. User runs `LAUNCHER.bat` again
6. Setup wizard detects hardware
7. Installs all dependencies (PyTorch, Triton, Unsloth, etc.)
8. App launches successfully

**Test Steps:**
```bash
# 1. Download the repo
git clone https://github.com/yourusername/Local-LLM-Server.git
cd Local-LLM-Server/LLM

# 2. Run launcher
LAUNCHER.bat

# Expected: Error about missing Python

# 3. Install Python 3.12 from python.org
# Make sure to check "Add Python to PATH"

# 4. Run launcher again
LAUNCHER.bat

# Expected: Setup wizard runs, installs everything
```

**Validation:**
- [ ] Setup wizard appears
- [ ] Hardware detection shows correct CPU, RAM
- [ ] Shows "CPU-only mode" message
- [ ] PyTorch installs successfully
- [ ] Dependencies install successfully
- [ ] `.setup_complete` marker created
- [ ] `.setup_state.json` created with correct info
- [ ] App launches without errors
- [ ] Second launch skips setup wizard

---

### Environment 2: Windows 11 + Python (RTX 4090)
**Purpose:** Test GPU detection and CUDA installation

**Setup:**
- Windows 11 with Python 3.12 installed
- NVIDIA RTX 4090 with driver 560.94
- No PyTorch or ML packages installed

**Expected Behavior:**
1. Setup wizard detects RTX 4090
2. Recommends CUDA 12.4 build
3. Installs `torch==2.5.1+cu124`
4. Installs `triton==3.0.0`
5. Installs Unsloth successfully
6. GPU is available in app

**Test Steps:**
```bash
# 1. Clone and run
cd Local-LLM-Server/LLM
LAUNCHER.bat

# Expected: Setup wizard detects GPU
```

**Validation:**
- [ ] Detects "RTX 4090"
- [ ] Shows "CUDA 12.4" in detection
- [ ] Installs cu124 build of PyTorch
- [ ] Triton 3.0.0 installed
- [ ] Unsloth imports without errors
- [ ] Training page shows "2 GPUs detected"
- [ ] Can select GPU for training
- [ ] Test training runs without Triton errors

---

### Environment 3: Windows 11 + Python (RTX A2000 + RTX 4090)
**Purpose:** Test multi-GPU detection

**Setup:**
- Windows 11 with Python 3.12
- RTX A2000 + RTX 4090 (mixed generation)
- CUDA driver 560.94

**Expected Behavior:**
1. Detects both GPUs
2. Uses newest GPU (RTX 4090) for CUDA version decision
3. Installs cu124 build (compatible with both)
4. Both GPUs selectable in training

**Test Steps:**
```bash
cd Local-LLM-Server/LLM
LAUNCHER.bat
```

**Validation:**
- [ ] Detects "2 GPUs"
- [ ] Lists both RTX A2000 and RTX 4090
- [ ] Installs CUDA 12.4 build
- [ ] Training page shows both GPUs
- [ ] Can select either GPU
- [ ] Training works on either GPU

---

### Environment 4: Windows 11 + Existing PyTorch (Wrong Version)
**Purpose:** Test version conflict handling

**Setup:**
- Windows 11 with Python 3.12
- PyTorch 2.6.0 already installed (incompatible)
- RTX 4090

**Expected Behavior:**
1. Setup wizard detects existing PyTorch
2. Detects version mismatch
3. Uninstalls old PyTorch
4. Installs compatible version (2.5.1)

**Test Steps:**
```bash
# 1. Pre-install incompatible PyTorch
pip install torch==2.6.0

# 2. Run launcher
cd Local-LLM-Server/LLM
LAUNCHER.bat

# Expected: Detects and fixes version
```

**Validation:**
- [ ] Detects existing PyTorch 2.6.0
- [ ] Shows warning about incompatibility
- [ ] Uninstalls old version
- [ ] Installs PyTorch 2.5.1
- [ ] Installs Triton 3.0.0
- [ ] No import errors for Unsloth

---

### Environment 5: Windows 11 + Old GPU (T1000)
**Purpose:** Test compatibility with older GPUs

**Setup:**
- Windows 11 with Python 3.12
- NVIDIA T1000 (Compute 7.5)
- CUDA driver 528.xx

**Expected Behavior:**
1. Detects T1000
2. Recommends CUDA 11.8 build
3. Installs cu118 PyTorch
4. Works with older GPU

**Test Steps:**
```bash
cd Local-LLM-Server/LLM
LAUNCHER.bat
```

**Validation:**
- [ ] Detects "T1000"
- [ ] Shows "CUDA 11.8 recommended"
- [ ] Installs cu118 build
- [ ] GPU available in training
- [ ] Training works (may be slower)

---

### Environment 6: Offline Mode (No Internet)
**Purpose:** Test graceful failure without internet

**Setup:**
- Windows 11 with Python 3.12
- Network disconnected

**Expected Behavior:**
1. Setup wizard attempts to install
2. Download fails with timeout
3. Shows clear error message
4. Suggests checking internet connection

**Test Steps:**
```bash
# 1. Disconnect internet
# 2. Run launcher
cd Local-LLM-Server/LLM
LAUNCHER.bat

# Expected: Error about no internet
```

**Validation:**
- [ ] Shows "No internet connection" error
- [ ] Doesn't crash
- [ ] Logs show timeout errors
- [ ] Can retry after reconnecting
- [ ] Retry button works

---

### Environment 7: Partial Installation Recovery
**Purpose:** Test recovery from interrupted setup

**Setup:**
- Windows 11 with Python 3.12
- Simulate interrupted setup (kill process mid-install)

**Expected Behavior:**
1. User runs setup
2. Setup interrupted (Ctrl+C or force close)
3. User runs launcher again
4. Detects partial installation
5. Resumes/retries installation

**Test Steps:**
```bash
# 1. Start setup
LAUNCHER.bat

# 2. During PyTorch download, press Ctrl+C

# 3. Run again
LAUNCHER.bat

# Expected: Detects incomplete setup, retries
```

**Validation:**
- [ ] Doesn't show "setup complete"
- [ ] Reruns setup wizard
- [ ] Completes installation
- [ ] Creates marker files

---

## Automated Testing Script

### Quick Test Script (PowerShell)
```powershell
# test_setup.ps1
# Quick automated test of setup process

$ErrorActionPreference = "Stop"

Write-Host "=== LLM Studio Setup Test ===" -ForegroundColor Cyan

# Test 1: Check Python
Write-Host "`n[Test 1] Checking Python..." -ForegroundColor Yellow
python --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Python not found" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Python found" -ForegroundColor Green

# Test 2: Check setup state
Write-Host "`n[Test 2] Checking setup state..." -ForegroundColor Yellow
python setup_state.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Setup not complete" -ForegroundColor Red
    Write-Host "Run LAUNCHER.bat first" -ForegroundColor Yellow
    exit 1
}
Write-Host "PASS: Setup complete" -ForegroundColor Green

# Test 3: Verify installation
Write-Host "`n[Test 3] Verifying installation..." -ForegroundColor Yellow
python verify_installation.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Installation verification failed" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Installation verified" -ForegroundColor Green

# Test 4: Test imports
Write-Host "`n[Test 4] Testing critical imports..." -ForegroundColor Yellow
python -c "import torch; import transformers; import PySide6; print('OK')"
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Import test failed" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: All imports successful" -ForegroundColor Green

# Test 5: Check CUDA
Write-Host "`n[Test 5] Checking CUDA..." -ForegroundColor Yellow
python -c "import torch; print('CUDA Available:', torch.cuda.is_available())"
Write-Host "PASS: CUDA check complete" -ForegroundColor Green

Write-Host "`n=== All Tests Passed ===" -ForegroundColor Green
```

---

## Manual Test Checklist

### First-Time Setup
- [ ] Launcher detects no setup
- [ ] Setup wizard appears
- [ ] Hardware detection runs
- [ ] Shows correct CPU/RAM/GPU info
- [ ] Progress bar updates during install
- [ ] Log shows installation progress
- [ ] Can view detailed logs
- [ ] Handles errors gracefully
- [ ] Shows clear error messages
- [ ] Creates `.setup_complete` marker
- [ ] Creates `.setup_state.json`
- [ ] "Launch Application" button enables
- [ ] App launches after setup

### Subsequent Launches
- [ ] Skips setup wizard
- [ ] Launches directly to app
- [ ] Loads previous settings
- [ ] GPU still detected correctly
- [ ] No dependency errors

### Setup State Persistence
- [ ] Setup state survives app restart
- [ ] Setup state survives PC restart
- [ ] Works after `git pull`
- [ ] Works on different user accounts
- [ ] Marker files in correct location

### Error Recovery
- [ ] Handles Ctrl+C during setup
- [ ] Retry button works after failure
- [ ] Can recover from download timeout
- [ ] Can recover from import errors
- [ ] Clear error messages
- [ ] Logs saved for debugging

### Version Compatibility
- [ ] Installs PyTorch 2.5.1
- [ ] Installs Triton 3.0.0
- [ ] Unsloth imports successfully
- [ ] No `AttrsDescriptor` errors
- [ ] Training runs without errors

### Cross-PC Compatibility
- [ ] Works on PC without Python
- [ ] Works on PC with Python 3.8
- [ ] Works on PC with Python 3.12
- [ ] Works with RTX 40xx series
- [ ] Works with RTX 30xx series
- [ ] Works with older GPUs
- [ ] Works on CPU-only systems

---

## Bug Report Template

If you encounter issues during testing, please report using this template:

```markdown
### Environment
- OS: Windows 11 [version]
- Python: [version]
- GPU: [model] or None
- CUDA Driver: [version] or N/A

### Steps to Reproduce
1. [Step 1]
2. [Step 2]
3. [Error occurred]

### Expected Behavior
[What should happen]

### Actual Behavior
[What actually happened]

### Error Messages
```
[Paste error messages here]
```

### Logs
[Attach or paste relevant logs from setup wizard]

### Screenshots
[If applicable]

### Additional Context
[Any other relevant information]
```

---

## Success Criteria

The installation is considered successful if:

1. ✅ Setup wizard completes without errors
2. ✅ All critical packages installed
3. ✅ PyTorch 2.5.1 + Triton 3.0.0
4. ✅ GPU detected (if available)
5. ✅ Unsloth imports successfully
6. ✅ Main application launches
7. ✅ Can download a model
8. ✅ Can start training without errors
9. ✅ Subsequent launches skip setup
10. ✅ Works on other PCs after `git pull`

---

## Known Issues & Workarounds

### Issue: Setup stuck on "Installing PyTorch"
**Cause:** Large download (2.5 GB)
**Workaround:** Wait 5-15 minutes, check internet speed

### Issue: "Unsloth import failed - Triton compatibility"
**Cause:** Wrong PyTorch/Triton version
**Fix:** Delete `.setup_complete`, run setup again

### Issue: GPU not detected despite driver installed
**Cause:** Driver too old or not in PATH
**Fix:** Update NVIDIA driver, restart PC, run setup again

### Issue: "Python not found"
**Cause:** Python not in system PATH
**Fix:** Reinstall Python with "Add to PATH" checked

---

## Reporting Results

After testing, please report results in this format:

```
Environment: [Windows 11 + RTX 4090]
Setup Time: [8 minutes]
Status: ✅ PASS / ❌ FAIL

Details:
- Hardware detection: ✅
- PyTorch install: ✅
- Dependency install: ✅
- App launch: ✅
- Training test: ✅

Notes:
[Any observations]
```

