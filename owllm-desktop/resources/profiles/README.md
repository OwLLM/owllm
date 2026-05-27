# Hardware Profile Files

Complete configuration for each GPU architecture. Each profile is **completely independent** - no mixing between hardware types.

## Profile Files

| File | Architecture | GPUs | CUDA | Status |
|------|--------------|------|------|--------|
| `ampere_cu121.json` | Ampere | RTX 3090/3080/3070/3060, A100/A2000/A6000 | 12.1 | ✅ Tested |
| `ada_cu124.json` | Ada Lovelace | RTX 4090/4080/4070/4060 | 12.4 | ❌ Not tested |
| `turing_cu118.json` | Turing | RTX 2080/2070/2060, T1000/T600 | 11.8 | 🔄 Testing |
| `blackwell_cu124.json` | Blackwell | RTX 5090/5080/5070 | 12.4 | ❌ Not tested |
| `hopper_cu124.json` | Hopper | H100 | 12.4 | ❌ Not tested |

## Automatic Selection

The installer automatically detects your GPU and loads **ONLY** the matching profile:

```
GPU Detected: RTX A2000 (compute 8.6)
         ↓
Profile Loaded: ampere_cu121.json
         ↓
Packages Installed: ONLY from that file
         ↓
NO mixing with other architectures
```

## Profile Structure

Each profile contains everything needed:

- **Python version**: min/max/recommended
- **CUDA version**: e.g., 12.1
- **torch_index**: PyTorch download URL
- **hardware**: compute capabilities, GPU list
- **packages**: ALL package versions (complete list)
- **testing info**: tested_on, last_verified

## Editing Profiles

**CRITICAL RULES:**
1. Only edit a profile if you have that hardware
2. Test changes on actual hardware before committing
3. Breaking one profile does NOT affect others
4. Each file is completely independent

## Example Profile

```json
{
  "architecture": "ampere",
  "cuda_version": "12.1",
  "python_version": {"min": "3.10", "max": "3.12"},
  "torch_index": "https://download.pytorch.org/whl/cu121",
  "packages": {
    "torch": "2.5.1+cu121",
    "transformers": "4.57.3",
    ...
  }
}
```

## Benefits

- ✅ **No cross-contamination**: Fixing T1000 won't break RTX A2000
- ✅ **Clear ownership**: One file = one architecture
- ✅ **Easy testing**: Test one hardware without affecting others
- ✅ **Version control**: See exactly what changed for which GPU
- ✅ **User visibility**: Tools page shows active profile
- ✅ **Simple debugging**: installer loads ONE file only

