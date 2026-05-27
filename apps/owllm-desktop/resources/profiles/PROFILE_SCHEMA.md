## Profile JSON schema (source of truth)

Each file in `LLM/profiles/` **is the canonical source** for dependency versions.

Required top-level fields:

```json
{
  "format_version": "1.0",
  "architecture": "ada",
  "cuda_version": "12.4",
  "profile_id": "ada_cu124",
  "description": "...",
  "python_version": { "min": "3.10", "max": "3.12", "recommended": "3.12" },
  "torch_index": "https://download.pytorch.org/whl/cu124",
  "hardware": {
    "compute_capability": ["8.9"],
    "cuda_versions": ["12.4", "12.5", "12.6"],
    "gpu_examples": ["RTX 4090", "..."]
  },
  "packages": {
    "torch": "2.5.1+cu124",
    "torchvision": "0.20.1+cu124",
    "torchaudio": "2.5.1+cu124",
    "transformers": ">=4.51.0,<4.60.0",
    "...": "..."
  },
  "tested": true,
  "tested_on": ["RTX 4090"],
  "notes": "Optional notes",
  "binary_packages": { "triton": { "type": "wheel", "url": "..." } }
}
```

Notes:
- `packages` includes both ML deps and server deps (`uvicorn`, `fastapi`, `pydantic`).
- Torch family uses CUDA-specific wheels; installers pick the right CUDA config from this profile.
- Add/modify dependencies **only here**; then run:
  - `python -m core.profile_sync generate` to regenerate derived files, or
  - `python scripts/verify_profiles_sync.py` to check they’re up-to-date.
