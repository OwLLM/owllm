# Migration Guide: Subprocess to Persistent Server

This guide helps you update existing code to use the new persistent server architecture.

## What Changed?

The `InferenceConfig` class now requires a `model_id` parameter instead of `base_model` and `adapter_dir`.

## Quick Migration

### Before (Old Code)

```python
from LLM.core.inference import InferenceConfig, run_inference

cfg = InferenceConfig(
    prompt="Hello world",
    base_model="/path/to/model",
    adapter_dir="/path/to/adapter",  # optional
    max_new_tokens=256,
    temperature=0.7
)

output = run_inference(cfg)
```

### After (New Code)

```python
from LLM.core.inference import InferenceConfig, run_inference

cfg = InferenceConfig(
    prompt="Hello world",
    model_id="default",  # NEW: references llm_backends.yaml
    max_new_tokens=256,
    temperature=0.7
)

output = run_inference(cfg)
```

## Step-by-Step Migration

### Step 1: Add Model to Config

Edit `LLM/configs/llm_backends.yaml`:

```yaml
models:
  my_model:  # This is your model_id
    base_model: "/path/to/model"  # Your old base_model path
    adapter_dir: "/path/to/adapter"  # Your old adapter_dir (or null)
    model_type: "instruct"  # or "base"
    port: 9100  # unique port
    use_4bit: true
```

### Step 2: Update Code

**Find all instances of:**
```python
InferenceConfig(
    prompt=...,
    base_model=...,
    adapter_dir=...,
)
```

**Replace with:**
```python
InferenceConfig(
    prompt=...,
    model_id="my_model",  # Your config key
)
```

### Step 3: Remove base_model/adapter_dir

The new `InferenceConfig` still has these fields for backward compatibility, but they're ignored. You can safely remove them:

```python
# OLD - these are ignored now
cfg = InferenceConfig(
    prompt="...",
    base_model="/path/to/model",  # ❌ Ignored
    adapter_dir="/path/to/adapter",  # ❌ Ignored
    model_id="default"  # ✅ Used
)

# NEW - cleaner
cfg = InferenceConfig(
    prompt="...",
    model_id="default"
)
```

## Tool-Enabled Inference

### Before

```python
cfg = ToolEnabledInferenceConfig(
    prompt="Use tools",
    base_model="/path/to/model",
    enable_tools=True
)
```

### After

```python
cfg = ToolEnabledInferenceConfig(
    prompt="Use tools",
    model_id="default",
    enable_tools=True
)
```

## Common Migration Patterns

### Pattern 1: Dynamic Model Selection

**Before:**
```python
def run_with_model(model_path, prompt):
    cfg = InferenceConfig(
        prompt=prompt,
        base_model=model_path
    )
    return run_inference(cfg)
```

**After:**
First, add all models to config:
```yaml
models:
  model_a:
    base_model: "/path/to/model_a"
    port: 9100
  model_b:
    base_model: "/path/to/model_b"
    port: 9101
```

Then:
```python
def run_with_model(model_id, prompt):
    cfg = InferenceConfig(
        prompt=prompt,
        model_id=model_id  # "model_a" or "model_b"
    )
    return run_inference(cfg)
```

### Pattern 2: Multiple Models in UI

**Before:**
```python
# UI code with model dropdown
selected_model = model_dropdown.currentText()  # Full path
cfg = InferenceConfig(prompt=prompt, base_model=selected_model)
```

**After:**
```python
# UI code with model dropdown
model_ids = ["default", "model_a", "model_b"]
selected_model_id = model_dropdown.currentText()  # Just ID
cfg = InferenceConfig(prompt=prompt, model_id=selected_model_id)
```

### Pattern 3: Testing with Different Adapters

**Before:**
```python
adapters = ["/path/adapter1", "/path/adapter2"]
for adapter in adapters:
    cfg = InferenceConfig(prompt=prompt, adapter_dir=adapter)
    result = run_inference(cfg)
```

**After:**
First configure:
```yaml
models:
  adapter1:
    base_model: "/path/to/base"
    adapter_dir: "/path/adapter1"
    port: 9100
  adapter2:
    base_model: "/path/to/base"
    adapter_dir: "/path/adapter2"
    port: 9101
```

Then:
```python
adapter_ids = ["adapter1", "adapter2"]
for adapter_id in adapter_ids:
    cfg = InferenceConfig(prompt=prompt, model_id=adapter_id)
    result = run_inference(cfg)
```

## UI Code Migration

### Desktop App Main Window

If your UI has model selection, update it:

**Before:**
```python
model_path = QFileDialog.getExistingDirectory()
cfg = InferenceConfig(prompt=prompt, base_model=model_path)
```

**After:**
```python
# Load model IDs from config
with open("LLM/configs/llm_backends.yaml") as f:
    config = yaml.safe_load(f)
    model_ids = list(config["models"].keys())

# Dropdown with model IDs
model_combo.addItems(model_ids)
selected_id = model_combo.currentText()

cfg = InferenceConfig(prompt=prompt, model_id=selected_id)
```

### Tool Chat Page

**File:** `LLM/desktop_app/pages/tool_chat_page.py`

Update model loading:

**Before:**
```python
cfg = ToolEnabledInferenceConfig(
    prompt=prompt,
    base_model=self.selected_model_path
)
```

**After:**
```python
cfg = ToolEnabledInferenceConfig(
    prompt=prompt,
    model_id=self.selected_model_id
)
```

## Testing Your Migration

1. **Quick test:**
   ```bash
   python LLM/tests/quick_test.py
   ```

2. **Full test:**
   ```bash
   python LLM/tests/test_persistent_server.py
   ```

3. **Tool test:**
   ```bash
   python LLM/tests/test_tool_iteration.py
   ```

## Troubleshooting

### Error: "Model 'X' not found in config"

**Solution:** Add the model to `llm_backends.yaml`:
```yaml
models:
  X:
    base_model: "/path/to/model"
    port: 9100
```

### Error: "model_id not provided"

**Solution:** Add `model_id` to your InferenceConfig:
```python
cfg = InferenceConfig(
    prompt="...",
    model_id="default"  # Add this
)
```

### Server Takes Forever to Start

**First time:** Normal - model is loading (2-3 minutes)
**Every time:** Check logs in server stderr output

### Port Already in Use

**Solution 1:** Change port in config
**Solution 2:** Kill existing process on that port

## Backward Compatibility

The old `base_model` and `adapter_dir` fields still exist in `InferenceConfig` for compatibility, but they're not used. You can keep them in your code temporarily during migration:

```python
# This works but is redundant
cfg = InferenceConfig(
    prompt="...",
    base_model="/old/path",  # Ignored
    adapter_dir="/old/adapter",  # Ignored
    model_id="default"  # Used
)
```

But eventually remove them for cleaner code.

## Rollback Plan

If you need to rollback:

1. Git revert changes to `LLM/core/inference.py`
2. Use old subprocess-based code
3. Delete new persistent server files

But you'll lose:
- Fast inference (<1s)
- Working tool calling iterations
- Model persistence

---

**Need Help?** Check logs in `LLM/logs/` directory or run tests in `LLM/tests/`
