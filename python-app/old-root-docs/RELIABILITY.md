# OWLLM Reliability Guide

## Overview
This guide shows how to add models, create environments, and run smoke tests in the refactored OWLLM system (Phases 1-4).

## System Architecture

OWLLM now uses:
- **StateStore** (SQLite) for runtime state
- **Shared environments** (env_key) instead of per-model envs
- **Atomic provisioning** for reliable environment creation
- **Strict JSON** tool calling with schema validation

## Adding a Model

### 1. Add to YAML Config (Static)

Edit `LLM/configs/llm_backends.yaml`:

```yaml
models:
  my_model:
    base_model: "path/to/model"  # Or HuggingFace ID
    adapter_dir: null
    model_type: "instruct"  # or "base"
    port: 10500  # Preferred port (hint only)
    use_4bit: true
    system_prompt: ""
```

**Note**: The `port` in YAML is just a *preferred* hint. Actual runtime ports are allocated dynamically and stored in StateStore.

### 2. Register in StateStore (Automatic)

On first server start, the model is automatically registered in StateStore:

```python
from core.state_store import get_state_store

state_store = get_state_store()
state_store.upsert_model(
    model_id="my_model",
    backend="transformers",
    model_path="path/to/model",
    env_key="torch-cu121-transformers-bnb",  # Resolved automatically
    params={"use_4bit": True}
)
```

### 3. Verify Registration

```bash
python -c "
from core.state_store import get_state_store
store = get_state_store()
print(store.get_model('my_model'))
"
```

## Creating an Environment

### Automatic (Recommended)

Environments are created automatically when you start a server for a model:

```python
from core.llm_server_manager import get_llm_server_manager
from core.inference import get_app_root

config_path = get_app_root() / "configs" / "llm_backends.yaml"
manager = get_llm_server_manager(config_path)

# This creates env if needed (atomic provisioning)
manager.start_server("my_model")
```

The system:
1. Resolves `env_key` from hardware profile + model requirements
2. Checks if env exists and is healthy
3. If not: creates atomically in `.envs/.tmp/<env_key>-<uuid>`
4. Installs dependencies + runs health checks
5. Renames to `.envs/<env_key>` on success
6. Updates StateStore with env status

### Manual (Advanced)

```python
from core.envs.env_registry import EnvRegistry

registry = EnvRegistry()

# Get env for model (creates if needed)
env_spec = registry.get_env_for_model("path/to/model")

print(f"Env key: {env_spec.key}")
print(f"Python: {env_spec.python_executable}")
```

### Environment Keys

Format: `<framework>-<cuda>-<backend>-<features>`

Examples:
- `torch-cu121-transformers-bnb` - Transformers + quantization (CUDA 12.1)
- `torch-cu124-transformers` - Transformers only (CUDA 12.4)
- `torch-cpu-transformers` - CPU-only
- `vllm-cu121` - vLLM with CUDA 12.1
- `llamacpp-cpu` - llama.cpp CPU

Multiple models can share the same env_key!

## Running Tests

### Environment Test

Test a specific environment's health:

```bash
python LLM/scripts/owllm.py env test torch-cu121-transformers-bnb
```

Output:
```json
{
  "env_key": "torch-cu121-transformers-bnb",
  "status": "PASS",
  "python_path": "C:/path/.envs/torch-cu121-transformers-bnb/.venv/Scripts/python.exe",
  "torch_version": "2.5.1+cu121",
  "cuda_available": true,
  "errors": []
}
```

### Model Smoke Test

Test model server startup, health, and generation:

```bash
python LLM/scripts/owllm.py model smoke my_model
```

Output:
```json
{
  "model_id": "my_model",
  "status": "PASS",
  "server_started": true,
  "health_ok": true,
  "generate_ok": true,
  "errors": []
}
```

### Tools Smoke Test

Test end-to-end tool calling:

```bash
python LLM/scripts/owllm.py tools smoke my_model
```

Output:
```json
{
  "model_id": "my_model",
  "status": "PASS",
  "server_started": true,
  "tool_server_ok": true,
  "tool_call_detected": true,
  "tool_executed": true,
  "errors": []
}
```

### pytest Suite

Run automated tests:

```bash
cd LLM
pytest tests/ -v

# Run specific test
pytest tests/test_env_health.py -v

# Skip GPU tests if no GPU
pytest tests/ -v -m "not gpu"
```

## Querying State

### List All Models

```python
from core.state_store import get_state_store

store = get_state_store()
models = store.list_models()

for model in models:
    print(f"{model['model_id']}: {model['backend']}, env_key={model['env_key']}")
```

### List All Environments

```python
envs = store.list_envs(status="READY")

for env in envs:
    print(f"{env['env_key']}: {env['status']}, torch={env['torch_version']}")
```

### List Running Servers

```python
servers = store.list_servers(status="RUNNING")

for server in servers:
    print(f"{server['model_id']}: port={server['port']}, pid={server['pid']}")
```

### Check Server Port

```python
server = store.get_server("my_model")
if server:
    print(f"Port: {server['port']}")
    print(f"Status: {server['status']}")
```

## Tool Calling

### Format

Tool calls must use strict JSON:

```json
{"tool": "calculator", "args": {"expression": "42*17"}, "id": "call_123"}
```

### Schema Validation

Tool calls are validated against `LLM/tools/schema.json`:

- `tool`: string, alphanumeric + underscore, starts with letter
- `args`: object (dict)
- `id`: string, unique identifier

Invalid calls are rejected.

### Prompt Templates

Use templates from `LLM/core/tool_prompts.py` to enforce JSON-only output:

```python
from core.tool_prompts import TRANSFORMERS_TEMPLATE

prompt = TRANSFORMERS_TEMPLATE.format(
    tools="calculator, web_search",
    prompt="Calculate 42 * 17"
)
```

## Troubleshooting

### Environment Creation Failed

```bash
# Check StateStore for error
python -c "
from core.state_store import get_state_store
env = get_state_store().get_env('torch-cu121-transformers-bnb')
if env and env['last_error']:
    print(env['last_error'])
"
```

### Server Won't Start

```bash
# Check port availability
python LLM/scripts/owllm.py model smoke my_model

# Check server state
python -c "
from core.state_store import get_state_store
server = get_state_store().get_server('my_model')
print(server)
"
```

### Tool Calls Not Detected

1. Check tool server is running:
   ```bash
   curl http://localhost:8763/health
   ```

2. Verify JSON format:
   ```json
   {"tool": "name", "args": {}, "id": "xyz"}
   ```

3. Run tools smoke test:
   ```bash
   python LLM/scripts/owllm.py tools smoke my_model
   ```

## Constraints Files

Environments generate constraints files in `LLM/constraints/<env_key>.txt` for reproducibility:

```bash
# View constraints
cat LLM/constraints/torch-cu121-transformers-bnb.txt

# Recreate env with exact versions
pip install -r LLM/constraints/torch-cu121-transformers-bnb.txt
```

## Best Practices

1. **Let env_key be resolved automatically** - Don't manually create envs unless needed
2. **Share environments** - Multiple models with same requirements use same env
3. **Check StateStore first** - Query runtime state from DB, not YAML
4. **Use CLI smoke tests** - Verify everything works after changes
5. **Atomic operations** - Environment creation is transactional (all-or-nothing)
6. **JSON-only tools** - Don't try XML/Python formats, they're removed

## Migration from Old System

If you have old per-model environments in `LLM/environments/`:

1. Old envs are detected but not used for new servers
2. New servers create shared envs in `LLM/.envs/`
3. Old envs can be removed after verification:
   ```bash
   # Verify new env works
   python LLM/scripts/owllm.py model smoke my_model
   
   # Remove old env (optional)
   rm -rf LLM/environments/<old_model_id>
   ```

## Summary

- **Add model** → Edit YAML + let system register in StateStore
- **Create env** → Automatic on first server start (atomic)
- **Test env** → `owllm env test <env_key>`
- **Test model** → `owllm model smoke <model_id>`
- **Test tools** → `owllm tools smoke <model_id>`
- **Query state** → Use StateStore methods (Python)
- **Reproducibility** → Constraints files in `constraints/`
- **Tool calling** → Strict JSON only, validated by schema
