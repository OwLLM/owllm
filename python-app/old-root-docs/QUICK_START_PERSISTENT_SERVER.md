# Quick Start Guide - Persistent LLM Server

## What Changed?

The LLM inference system now uses **persistent servers** instead of subprocess calls. This means:

- ✅ Model loads once and stays in memory
- ✅ Fast generations (<1s after first load)
- ✅ Tool calling actually works (multiple iterations)
- ✅ No more 30-second waits between tool calls

## Quick Test (5 minutes)

### Step 1: Verify Configuration

Check that `LLM/configs/llm_backends.yaml` has correct model path:

```yaml
models:
  default:
    base_model: "C:/1_GitHome/Local-LLM-Server/LLM/models/unsloth__Phi-4-bnb-4bit"
    adapter_dir: null
    model_type: "instruct"
    port: 9100
    use_4bit: true
```

Update the path if your model is elsewhere.

### Step 2: Run Quick Test

```bash
python LLM/tests/quick_test.py
```

**First run:** 2-3 minutes (model loading)
**Subsequent runs:** <1 second

### Step 3: Use in Your Code

**Before (old way - DON'T USE):**
```python
cfg = InferenceConfig(
    prompt="Hello",
    base_model="path/to/model",  # ❌ Old way
)
```

**After (new way - USE THIS):**
```python
cfg = InferenceConfig(
    prompt="Hello",
    model_id="default",  # ✅ New way - references config
    max_new_tokens=256,
    temperature=0.7
)

output = run_inference(cfg)
```

## Tool Calling Example

```python
from LLM.core.inference import ToolEnabledInferenceConfig, run_inference_with_tools

cfg = ToolEnabledInferenceConfig(
    prompt="Use the get_time tool to tell me the current time.",
    model_id="default",
    enable_tools=True,
    auto_execute_safe_tools=True,
    max_tool_iterations=5
)

final_output, tool_log = run_inference_with_tools(cfg)
print(final_output)
print(f"Tools used: {len(tool_log)}")
```

## Adding New Models

Edit `LLM/configs/llm_backends.yaml`:

```yaml
models:
  my_custom_model:
    base_model: "path/to/your/model"
    adapter_dir: "path/to/adapter"  # or null
    model_type: "instruct"  # or "base"
    port: 9101  # unique port per model
    use_4bit: true
```

Then use it:

```python
cfg = InferenceConfig(
    prompt="Hello",
    model_id="my_custom_model"
)
```

## Troubleshooting

### "Model not found"
- Check model path in `llm_backends.yaml`
- Verify model directory has `config.json`

### "Port already in use"
- Change port in config
- Or stop existing server: find process on that port and kill it

### "Server timeout"
- First start takes 2-3 minutes (normal)
- Increase timeout in `llm_server_manager.py` if needed

### "Environment not found"
- Run environment manager to create it
- Check `LLM/environments/` directory

## Running Tests

```bash
# Test server lifecycle
python LLM/tests/test_persistent_server.py

# Test tool calling
python LLM/tests/test_tool_iteration.py

# Test environment isolation
python LLM/tests/test_env_isolation.py
```

## What Stays The Same?

- UI code doesn't change
- Tool server doesn't change
- Tool definitions don't change
- MCP integration doesn't change

## What's Different?

- Must specify `model_id` instead of `base_model` in config
- First inference call starts server (slow)
- Subsequent calls are fast (<1s)
- Servers stay running in background

## Stopping Servers

Servers auto-stop when main app exits. To manually stop:

```python
from LLM.core.llm_server_manager import get_global_server_manager

manager = get_global_server_manager()
manager.shutdown_server("default")  # Stop specific model
manager.shutdown_all()  # Stop all servers
```

---

**Ready to test?** Run: `python LLM/tests/quick_test.py`
