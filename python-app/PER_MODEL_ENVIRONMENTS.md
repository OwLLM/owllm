# Per-Model Isolated Environments

## Architecture Overview

Each model now has its own **isolated Python environment** with its own Python runtime and packages. This ensures:

1. **No conflicts**: Different models can have different package versions
2. **Isolation**: System Python is never touched - only used to bootstrap the installer
3. **Self-contained**: Each environment uses the self-contained Python runtime from `python_runtime/`
4. **Automatic**: Environments are created automatically when a model runs

## How It Works

### Environment Location

Environments are stored in:
```
LLM/environments/
  ├── nvidia__Nemotron-3-30B/
  │   ├── .venv/              # Isolated Python environment
  │   └── environment_metadata.json
  ├── unsloth__Qwen2.5-7B-Instruct-bnb-4bit/
  │   ├── .venv/
  │   └── environment_metadata.json
  └── ...
```

### Environment Creation

When a model runs:
1. System extracts model ID from model path (e.g., `models/nvidia__Nemotron-3-30B/` → `nvidia/Nemotron-3-30B`)
2. Checks if environment exists for that model
3. If not, creates it using self-contained Python runtime
4. Installs packages into that model's environment based on hardware profile
5. Runs the model using that environment's Python

### Python Runtime

- **System Python**: Only used to bootstrap the installer (creates `bootstrap/.venv`)
- **Self-contained Python**: Downloaded to `LLM/python_runtime/python3.12/` - used to create model environments
- **Model Environments**: Each has its own `.venv` created from self-contained Python

## Benefits

1. **No System Pollution**: System Python is never modified
2. **Version Independence**: Model A can use PyTorch 2.5.1+cu121 while Model B uses 2.5.1+cu124
3. **Easy Cleanup**: Delete `LLM/environments/<model_id>/` to remove a model's environment
4. **Automatic Management**: Environments are created/updated automatically

## Backward Compatibility

- Shared `LLM/.venv` still exists for backward compatibility
- If a model doesn't have its own environment, it falls back to shared `.venv`
- Requirements page shows shared environment status (can be extended to show per-model later)

## Implementation Details

### EnvironmentManager (`core/environment_manager.py`)

- `get_environment_path(model_id, model_path)`: Get environment directory for a model
- `get_python_executable(model_id, model_path)`: Get Python executable for a model
- `create_environment(...)`: Create new isolated environment
- `environment_exists(...)`: Check if environment exists

### Model Execution

When `_run_inference_a/b/c()` is called:
1. Extracts model_id from model_path
2. Calls `_ensure_model_environment()` to create/get environment
3. Uses that environment's Python to run the model

### Installer Integration

- `InstallerV2.repair_model_environment()`: Repair a specific model's environment
- Uses same wheelhouse and profile selection as shared repair
- Installs packages into model-specific environment

## Future Enhancements

- Per-model requirements page showing each model's package status
- Environment management UI (create/delete environments)
- Environment templates for common model types
- Shared base environments with model-specific overrides
