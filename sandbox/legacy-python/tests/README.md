# Test Suite for Persistent LLM Inference Server

This directory contains comprehensive tests for the persistent server architecture.

## Test Files

### 1. `test_persistent_server.py`
Tests server lifecycle and model persistence:
- Server starts successfully
- Health checks pass
- Multiple sequential generations work
- Model stays loaded in memory (fast subsequent calls)
- Server can be shut down cleanly

**Run:**
```bash
python LLM/tests/test_persistent_server.py
```

### 2. `test_tool_iteration.py`
Tests tool calling with persistent server:
- Tool detection works
- Tools are executed correctly
- Results are fed back to the model
- Conversation history accumulates properly
- Multiple tool iterations work

**Run:**
```bash
python LLM/tests/test_tool_iteration.py
```

### 3. `test_env_isolation.py`
Tests environment isolation:
- Main app doesn't import torch/transformers
- Environment registry works correctly
- Python executables are validated
- Different models can use different environments

**Run:**
```bash
python LLM/tests/test_env_isolation.py
```

## Running All Tests

```bash
python LLM/tests/test_persistent_server.py && \
python LLM/tests/test_tool_iteration.py && \
python LLM/tests/test_env_isolation.py
```

Or on Windows PowerShell:
```powershell
python LLM/tests/test_persistent_server.py; if ($?) { python LLM/tests/test_tool_iteration.py }; if ($?) { python LLM/tests/test_env_isolation.py }
```

## Expected Outcomes

### Success Criteria
- All tests pass without errors
- Model loads once and stays loaded
- Generation times are consistent (<1s after first load)
- Tools execute successfully
- Main app environment is clean

### Common Issues

1. **Model not found**: Update `llm_backends.yaml` with correct model path
2. **Port in use**: Change port in config or stop conflicting process
3. **Environment missing**: Run environment manager to create it
4. **Timeout**: Increase `warmup_timeout` in `llm_server_manager.py`

## Notes

- First test may take 2-3 minutes (model loading)
- Subsequent tests should be faster (environment already exists)
- Tool calling test may not execute tools if model isn't trained for it
- Environment isolation test will warn if main app has GPU dependencies
