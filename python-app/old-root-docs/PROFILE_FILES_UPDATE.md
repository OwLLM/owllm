# Profile Files Update - Server Dependencies Added

## What Was Updated

All hardware profile files (source of truth) have been updated to include **server dependencies** required for the LLM inference server.

## Files Updated

### Profile Files (`LLM/profiles/`):
1. ✅ `ampere_cu121.json` - Ampere architecture (RTX 3000, A-series)
2. ✅ `ada_cu124.json` - Ada Lovelace (RTX 4000 series)
3. ✅ `turing_cu118.json` - Turing (RTX 2000, T-series)
4. ✅ `blackwell_cu124.json` - Blackwell (RTX 5000 series)
5. ✅ `hopper_cu124.json` - Hopper (H100)

### Metadata Profile Files (`LLM/metadata/hardware_profiles/`):
1. ✅ `ampere_cu121.json`
2. ✅ `ada_cu124.json`
3. ✅ `turing_cu118.json`
4. ✅ `blackwell_cu124.json`
5. ✅ `hopper_cu124.json`

**Total: 10 files updated**

## Dependencies Added

All profiles now include:

```json
"uvicorn": ">=0.30.0,<1.0.0",
"fastapi": ">=0.115.0,<1.0.0",
"pydantic": ">=2.0.0,<3.0.0"
```

## Why This Was Needed

The LLM inference server requires:
- **uvicorn**: ASGI server to run FastAPI
- **fastapi**: Web framework for the API
- **pydantic**: Data validation (used by FastAPI)

Previously, these were only installed by `env_registry.py` when creating environments. Now they're in the **source of truth** (profile files) so:

1. ✅ **Consistency**: All environments get server deps from profiles
2. ✅ **Documentation**: Clear what packages each architecture needs
3. ✅ **Future-proof**: If environment manager uses profiles, server deps are included
4. ✅ **Version control**: Server dependency versions are tracked in profiles

## Impact

### Before:
- Server dependencies only installed by `env_registry.py`
- Not documented in profile files
- Could be missing if environment created differently

### After:
- Server dependencies in all profile files (source of truth)
- `env_registry.py` still installs them (backup/fallback)
- Documented and version-controlled
- Consistent across all architectures

## Testing

When environments are created using profiles, they will now include:
- ✅ All ML packages (transformers, peft, torch, etc.)
- ✅ Server packages (uvicorn, fastapi, pydantic)
- ✅ GUI packages (PySide6, streamlit, etc.)

## Notes

- **Version ranges**: Used flexible ranges (`>=X,<Y`) for compatibility
- **No breaking changes**: Existing environments still work
- **Future environments**: Will automatically get server deps from profiles
- **Backward compatible**: `env_registry.py` still installs deps if missing

---

**Status:** ✅ All profile files updated with server dependencies

**Next:** Environments created from profiles will include server dependencies automatically
