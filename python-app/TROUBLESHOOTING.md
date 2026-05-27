# Troubleshooting Guide

## Issue: Training logs not appearing / Cannot abort training

### Root Cause
The issue was caused by **missing dependencies**. The `unsloth` library was not installed in the virtual environment, causing the training process to crash immediately on startup.

### What Was Happening
1. When you clicked "Start Training", the GUI launched `finetune.py`
2. `finetune.py` tried to import `unsloth` but failed with `ModuleNotFoundError`
3. The process crashed before any output could be captured
4. The GUI showed "⚠️ Process not tracked - may have failed to start"

### Solution Applied
1. **Installed unsloth and dependencies:**
   ```bash
   pip install --upgrade "unsloth[cu121-torch250]@git+https://github.com/unslothai/unsloth.git" --force-reinstall --no-deps
   ```

2. **Fixed PyTorch version compatibility:**
   - Uninstalled incompatible torch 2.9.1 (CPU-only)
   - Reinstalled torch 2.5.1+cu121 (with CUDA support)
   - Installed compatible xformers 0.0.27

3. **Fixed Windows Unicode encoding:**
   - Set `PYTHONIOENCODING=utf-8` in environment variables
   - This prevents crashes from emoji/Unicode characters in console output

### Verification
Run this command to verify finetune.py works:
```bash
cd C:\1_GitHome\Local-LLM-Server\LLM
.\.venv\Scripts\python.exe -u finetune.py --help
```

Expected output should show:
- 🦥 Unsloth patches messages
- ⚙️ WANDB offline mode message
- Usage/help text with all arguments

### Current Status
✅ All dependencies installed and compatible
✅ PyTorch with CUDA 12.1 support
✅ UTF-8 encoding configured
✅ Training script verified working

### Training Should Now Work
1. Refresh your browser (Ctrl+F5)
2. Go to "Train Model" page
3. Configure training parameters
4. Click "🚀 Start Training"
5. Logs should appear in real-time
6. "🛑 Stop Training" button should work to abort

### If Issues Persist
1. Check the log file: `LLM/training_log.txt`
2. Use the "🧪 Test if finetune.py works" button in the diagnostics section
3. Verify GPU is detected in the sidebar (should show your GPU name)
4. Check "Process Status & Diagnostics" section while training

## Common Errors

### ModuleNotFoundError: No module named 'unsloth'
**Solution:** Run `pip install unsloth` in your virtual environment

### NotImplementedError: Unsloth cannot find any torch accelerator
**Solution:** Install PyTorch with CUDA support:
```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

### UnicodeEncodeError: 'charmap' codec can't encode characters
**Solution:** Set environment variable before running:
```bash
$env:PYTHONIOENCODING='utf-8'  # PowerShell
set PYTHONIOENCODING=utf-8      # CMD
```

## Version Compatibility
The following versions are tested and working:
- Python: 3.12
- PyTorch: 2.5.1+cu121
- CUDA: 12.1
- unsloth: 2025.12.6
- xformers: 0.0.27
- transformers: 4.57.3
- trl: 0.24.0
- streamlit: 1.28+

## Need Help?
If you continue experiencing issues:
1. Check terminal/console output for error messages
2. Look at `training_log.txt` in the LLM directory
3. Verify GPU is available: `nvidia-smi` command should work
4. Ensure Visual C++ Redistributables are installed (required for PyTorch on Windows)

