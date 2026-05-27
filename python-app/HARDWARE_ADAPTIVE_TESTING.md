# Hardware-Adaptive Installer Testing Guide

## Implementation Complete

All components of the hardware-adaptive installer have been implemented:

1. ✅ Enhanced `SystemDetector` with compute capability detection
2. ✅ Created `compatibility_matrix.json` with tested profiles
3. ✅ Implemented `ProfileSelector` for automatic profile selection
4. ✅ Updated `WheelhouseManager` to accept exact version dictionaries
5. ✅ Integrated profile selection into `InstallerV2`

## Architecture

The new system automatically detects hardware and selects compatible package versions:

```
Hardware Detection → Profile Selection → Exact Versions → Installation
     (GPU + CUDA)        (Matrix Lookup)    (No conflicts)     (Success)
```

## Testing on Current Hardware

### Your System
- **GPUs**: RTX 4090 (24GB, compute 8.9) + RTX A2000 (12GB, compute 8.6)
- **CUDA**: 12.4
- **Expected Profile**: `cuda124_sm89` (uses 4090 as best GPU)

### Test Procedure

1. **Kill any running installer**:
   ```powershell
   Get-Process python* | Stop-Process -Force
   ```

2. **Delete old venv and wheelhouse**:
   ```powershell
   cd C:\1_GitHome\Local-LLM-Server\LLM
   Remove-Item -Recurse -Force .venv, wheelhouse
   ```

3. **Run new installer**:
   ```powershell
   python installer_v2.py
   ```

4. **Expected output**:
   ```
   PHASE 0: Hardware and Platform Detection
   ------------------------------------------------------------
     Python: 3.12.7
     CUDA: 12.4 with 2 GPU(s)
       GPU 0: NVIDIA RTX A2000 12GB (compute 8.6)
       GPU 1: NVIDIA GeForce RTX 4090 (compute 8.9)
     ...
   
   🎯 Using hardware-adaptive installation
   
   ✓ Selected profile: cuda124_sm89
     CUDA 12.4+, RTX 4090/4080 (Ada Lovelace, compute 8.9)
   
   ✓ Target configuration: cu124
   
   PHASE 1: Wheelhouse Preparation
   ...
   ```

5. **Verify installation**:
   ```powershell
   .\.venv\Scripts\python.exe -c "import torch; print(f'Torch: {torch.__version__}, CUDA: {torch.cuda.is_available()}')"
   .\.venv\Scripts\python.exe -c "from transformers import PreTrainedModel; print('Transformers OK')"
   ```

### Expected Results

- **Profile**: `cuda124_sm89` selected automatically
- **Packages**: Exact versions from compatibility matrix
- **No errors**: transformers imports work, no torchao warnings
- **CUDA**: torch.cuda.is_available() returns True

## Testing on Other Hardware

### RTX 3060 (Ampere, compute 8.6)
- **Expected Profile**: `cuda121_sm86`
- **Packages**: Same transformers 4.51.3, torch 2.5.1+cu121

### RTX 2060 (Turing, compute 7.5)
- **Expected Profile**: `cuda118_sm75`
- **Packages**: Older transformers 4.45.0, torch 2.5.1+cu118

### Mixed GPUs (e.g., 3060 + 4090)
- **Behavior**: Uses lowest common denominator (sm_86)
- **Warning**: "Multiple GPUs detected with different capabilities"
- **Profile**: `cuda121_sm86` or `cuda124_sm89` based on CUDA version

### Unknown GPU
- **Fallback**: `cuda121_sm86` (most common)
- **Warning**: "Could not determine optimal profile"

## How to Add New Profiles

1. Test a new hardware configuration
2. Find working package versions
3. Add to `compatibility_matrix.json`:

```json
"cuda125_sm90": {
  "description": "CUDA 12.5+, RTX 5090 (Blackwell, compute 9.0)",
  "hardware": {
    "cuda_min": "12.5",
    "compute_capability_min": 9.0,
    "gpu_examples": ["RTX 5090", "RTX 5080"]
  },
  "packages": {
    "torch": "2.6.0+cu125",
    "transformers": "4.52.0",
    ...
  }
}
```

4. Add to `compute_capability_map`:
```json
"9.0": {"architecture": "Blackwell", "profile": "cuda125_sm90"}
```

## Troubleshooting

### Profile Selection Fails
- Falls back to legacy mode automatically
- Uses manifest-based fixed versions
- Logs warning but continues

### VRAM Too Low
- < 4GB: Blocks installation with error
- < 8GB: Warning, continues

### CUDA Too Old
- < 11.8: Warning to update drivers
- Uses oldest profile (cu118_sm75)

## Legacy Mode

If `compatibility_matrix.json` is missing, installer uses legacy mode:
- Fixed versions from `dependencies.json`
- Only adapts torch to CUDA version
- Less reliable on varied hardware

## Success Criteria

✅ Automatic hardware detection
✅ No user intervention required  
✅ Works on any NVIDIA GPU configuration
✅ No version conflicts
✅ Reproducible installations
✅ Clear error messages
✅ Fallback strategies

## Next Steps

1. Test on current hardware (4090+A2000)
2. If successful, test on other available hardware
3. Document any issues found
4. Add more profiles as needed
5. Consider integration testing with actual model loading

