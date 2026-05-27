# Port Configuration Explained

## Two Different Servers, Two Different Ports

Your application uses **TWO SEPARATE SERVERS** that run on different ports:

### 1. Tool Server (MCP Server) - Port 8763
- **Purpose**: Provides tools (calculator, weather, file operations, etc.)
- **Location**: Defined in `LLM/desktop_app/config/tool_server.json`
- **Started by**: The main application (desktop_app)
- **Port**: `8763` (hardcoded in code)
- **Used by**: LLMs call this to execute tools

### 2. LLM Inference Server - Port 9200 (configurable)
- **Purpose**: Runs the actual LLM model (loads model into GPU, generates text)
- **Location**: Defined in `LLM/configs/llm_backends.yaml`
- **Started by**: `LLMServerManager` when tool-enabled inference runs
- **Port**: `9200` for default model (can be changed in YAML)
- **Used by**: Main app calls this to get LLM generations

## How They Work Together

```
User Message
    ↓
Main App (desktop_app/main.py)
    ↓
[1] Calls LLM Server (port 9200) → "What's 2+2?"
    ↓
LLM Server returns: "Let me use calculator tool"
    ↓
[2] Main app detects tool call → Calls Tool Server (port 8763)
    ↓
Tool Server executes calculator(2, 2) → Returns "4"
    ↓
[3] Main app sends result back to LLM Server (port 9200)
    ↓
LLM Server returns: "The answer is 4"
    ↓
Display to user
```

## Port Configuration

### Tool Server Port (8763)
Currently hardcoded in the code. To change:
- Edit `LLM/desktop_app/main.py` → Search for `8763`
- Update the port in `ToolEnabledInferenceConfig`

### LLM Server Port (9200)
Configured in `LLM/configs/llm_backends.yaml`:

```yaml
models:
  default:
    port: 9200  # ← Change this
```

**Important:** Each model configuration needs a unique port!

## Why Port 9100 Failed

The error you saw:
```
Port 9100 is in use but not responding to health checks
```

This happened because:
1. Port 9100 was already occupied by another process
2. OR a previous server crashed and left the port in TIME_WAIT state

**Solution:** Changed default model port from `9100` → `9200` in the config.

## Port Ranges Recommended

- **Tool Server**: 8763 (fixed)
- **LLM Servers**: 10500-10599 (one per model)

Example for multiple models:
```yaml
models:
  default:        port: 10500
  phi4_assistant: port: 10501
  llama_3:        port: 10502
  mistral:        port: 10503
```

## Checking Port Usage

To see what's using a port:

**Windows:**
```cmd
netstat -ano | findstr :9200
```

**Linux/Mac:**
```bash
lsof -i :9200
```

## Summary

- **8763**: Tool server (MCP) - provides calculator, weather, etc.
- **10500**: LLM server (FastAPI) - runs the actual AI model
- They are completely separate services
- Both are needed for tool-enabled chat
- Make sure ports don't conflict!

---

**Current Status:** 
- ✅ Tool Server: Port 8763
- ✅ LLM Server (default model): Port 10500 (changed from 9100 → 9200 → 10500)
- ✅ Improved port handling with SO_REUSEADDR and retry logic
