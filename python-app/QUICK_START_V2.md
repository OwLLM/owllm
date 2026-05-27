# Quick Start Guide - Immutable Installer V2

## For Users

### First Time Installation

1. **Open Command Prompt or PowerShell**

2. **Navigate to LLM directory**:
   ```bash
   cd C:\path\to\Local-LLM-Server\LLM
   ```

3. **Run the installer**:
   ```bash
   python installer_v2.py
   ```

4. **Wait for completion** (~5-10 minutes):
   - Downloads wheels to wheelhouse
   - Creates fresh virtual environment
   - Installs all packages offline
   - Verifies installation

5. **Launch the application**:
   ```bash
   python installer_gui.py
   ```
   Then click "Launch App" button.

### Using the GUI

1. **Run the installer GUI**:
   ```bash
   python installer_gui.py
   ```

2. **Click "Install/Repair All"**

3. **Wait for installation to complete**

4. **Click "Launch App"** when enabled

## For Developers

### Testing the Installer

```bash
# Test CLI help
python installer_v2.py --help

# Test detection only (no install)
python -c "from installer_v2 import InstallerV2; inst = InstallerV2(); inst._display_detection_results(inst._determine_cuda_config.__self__.detector.detect_all())"

# Verify existing installation
python installer_v2.py --verify
```

### Manual Verification

After installation completes:

```bash
# Activate venv
.venv\Scripts\activate

# Test torch
python -c "import torch; print(f'torch {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}')"

# Test transformers
python -c "from transformers import PreTrainedModel, AutoModel; print('transformers OK')"

# Test no torchao
python -c "import importlib.util; assert importlib.util.find_spec('torchao') is None; print('No blacklisted packages')"

# Test GPU
python -c "import torch; print(torch.cuda.get_device_name(0))"
```

All commands should succeed without errors.

### Troubleshooting

**Problem**: "No CUDA GPU detected"
**Solution**: 
1. Check NVIDIA drivers: `nvidia-smi`
2. Update drivers from NVIDIA website
3. Restart computer
4. Re-run installer

**Problem**: "Blacklisted package found"
**Solution**:
- This means one of your dependencies requires torchao
- Check `wheelhouse/` directory for torchao*.whl files
- That dependency cannot be installed (likely unsloth)
- Remove that dependency from requirements

**Problem**: Installation takes too long
**Solution**:
- First run downloads ~2GB of wheels (slow)
- Subsequent runs use cached wheelhouse (faster)
- Use `--skip-wheelhouse` flag to skip downloads

## Architecture Overview

```
┌─────────────────────────────────────┐
│  User runs installer_v2.py or GUI  │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  PHASE 0: Detection                 │
│  - Detect CUDA version              │
│  - Determine cu124/cu121/cu118      │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  PHASE 1: Wheelhouse                │
│  - Download torch from CUDA index   │
│  - Download deps from PyPI          │
│  - CHECK FOR BLACKLIST → ABORT!     │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  PHASE 2: Destroy Venv              │
│  - Force delete existing .venv      │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  PHASE 3: Create Fresh Venv         │
│  - python -m venv .venv --clear     │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  PHASE 4: Install Offline           │
│  - pip install --no-index --no-deps │
│  - From wheelhouse only             │
│  - Strict order: base→torch→HF→GUI  │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  PHASE 5: Clear Cache               │
│  - Remove __pycache__               │
│  - Remove .pyc files                │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  PHASE 6: Verify                    │
│  - torch.cuda.is_available()        │
│  - from transformers import ...     │
│  - No blacklisted packages          │
│  - IF FAIL → DELETE VENV            │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  SUCCESS                            │
│  Environment ready!                 │
└─────────────────────────────────────┘
```

## Key Files

- `installer_v2.py` - Main coordinator
- `metadata/dependencies.json` - Package manifest
- `core/wheelhouse.py` - Wheel download manager
- `core/immutable_installer.py` - Atomic installer
- `core/verification.py` - Verification system
- `installer_gui.py` - GUI (uses InstallerV2)
- `wheelhouse/` - Downloaded wheels (created on first run)

## FAQ

**Q: Why does it delete my venv every time?**
A: To guarantee a clean, reproducible state. Repairing in place accumulates drift.

**Q: Can I keep my existing venv?**
A: No. The immutable installer always starts fresh. This is intentional.

**Q: What if I already have packages installed?**
A: They'll be deleted and reinstalled. Old installation is not reused.

**Q: Why is unsloth not installed?**
A: unsloth requires torchao which conflicts with transformers. It's blacklisted.

**Q: Can I install additional packages after?**
A: Yes, but use `pip install --no-deps` or ensure they don't pull in torch.

**Q: How do I update packages?**
A: Update `metadata/dependencies.json`, delete `wheelhouse/`, re-run installer.

## Support

For issues:
1. Check `logs/installer_thread.log`
2. Run `python installer_v2.py --verify`
3. Check this guide's troubleshooting section
4. Check `IMMUTABLE_INSTALLER_V2.md` for details

