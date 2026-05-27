# Hardware Profile Files

Each JSON file contains the complete package specification for a specific GPU architecture.

## Architecture Mapping

| Compute Capability | Architecture | Profile File | GPUs |
|-------------------|--------------|--------------|------|
| 7.5 | Turing | `turing_cu118.json` | RTX 2080 Ti, 2080, 2070, 2060, T1000, T600, T400 |
| 8.0, 8.6 | Ampere | `ampere_cu121.json` | RTX 3090, 3080, 3070, 3060, A100, A2000, A6000 |
| 8.9 | Ada Lovelace | `ada_cu124.json` | RTX 4090, 4080, 4070, 4060 |
| 9.0 | Hopper | `hopper_cu124.json` | H100 |
| 10.0 | Blackwell | `blackwell_cu124.json` | RTX 5090, 5080, 5070 |

## File Format

```json
{
  "format_version": "1.0",
  "architecture": "ampere",
  "cuda_version": "12.1",
  "profile_id": "ampere_cu121",
  "description": "Human-readable description",
  "hardware": {
    "compute_capability": ["8.0", "8.6"],
    "cuda_versions": ["12.1", "12.2", "12.3"],
    "gpu_examples": ["GPU names"]
  },
  "packages": {
    "package_name": "exact_version",
    ...
  },
  "tested": true,
  "tested_on": ["GPU list"],
  "last_verified": "2025-01-30",
  "notes": "Additional information"
}
```

## Usage

The installer automatically:
1. Detects your GPU's compute capability
2. Loads the **ONLY** matching profile file
3. Installs packages from that profile
4. **Never mixes** requirements between different architectures

## Adding New Profiles

1. Copy an existing profile file
2. Update the architecture, CUDA version, and compute capability
3. Adjust package versions as needed for that hardware
4. Test on actual hardware
5. Update this README

## Testing Status

- ✅ `ampere_cu121.json` - Verified on RTX A2000 + RTX 4090
- 🔄 `turing_cu118.json` - Testing on T1000
- ❌ `ada_cu124.json` - Not yet tested
- ❌ `blackwell_cu124.json` - Not yet tested
- ❌ `hopper_cu124.json` - Not yet tested

## Important Notes

- **Do NOT modify a profile file unless testing on that exact hardware**
- Each profile is independent - fixing one doesn't affect others
- Breaking changes in one profile won't affect other architectures
- Version control shows exactly which hardware's config changed

