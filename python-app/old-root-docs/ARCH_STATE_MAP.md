# OWLLM Architecture State Map

## Overview
This document maps the state storage architecture in OWLLM, showing where configuration and runtime state lives.

## BEFORE Phase 1 (Original Architecture)

### State Stores
Multiple sources of truth with potential drift:

1. **`LLM/configs/llm_backends.yaml`**
   - Model configurations (base_model, adapter_dir, port, system_prompt, use_4bit)
   - **PROBLEM**: Rewritten at runtime when ports conflict
   - **PROBLEM**: No distinction between static config and runtime state

2. **`LLM/environments/*/environment_metadata.json`**
   - Per-environment metadata (model associations, Python version, package count)
   - **PROBLEM**: Per-model environments cause disk bloat
   - **PROBLEM**: No atomic provisioning (partial failures leave corrupt envs)

3. **`LLM/core/llm_server_manager.py` (in-memory)**
   - `running_servers` dict mapping model_id → subprocess.Popen
   - **PROBLEM**: Lost on restart, no persistence
   - **PROBLEM**: No way to query what's actually running

4. **`LLM/desktop_app/config/tool_server.json`**
   - Tool server configuration (port, host, token)
   - **PROBLEM**: Separate config file, no integration with model/server state

### Problems Identified
- **Config drift**: YAML rewritten at runtime → git conflicts, unpredictable state
- **No single source of truth**: Model/env/server mappings scattered across files
- **No atomicity**: Environment creation can fail partway, leaving broken state
- **No history**: Can't query "what port was model X using?" after restart
- **Testing impossible**: No way to verify env/model/server health systematically

## AFTER Phase 1 (StateStore Architecture)

### Single Source of Truth: `data/owllm_state.db` (SQLite)

#### Tables

**`models`**
- `model_id` (PK)
- `backend` (transformers, vllm, llamacpp)
- `model_path` (filesystem path to model)
- `env_key` (references envs table) - PHASE 2
- `params_json` (additional params as JSON)
- `created_at`, `updated_at`

**`envs`** - PHASE 2
- `env_key` (PK, e.g., "torch-cu121-transformers-bnb")
- `python_path`, `torch_version`, `cuda_version`
- `backend`, `constraints_hash`
- `status` (CREATING | READY | FAILED)
- `last_error`
- `created_at`, `updated_at`

**`servers`**
- `model_id` (PK, FK to models)
- `pid` (process ID)
- `port` (runtime-allocated port)
- `status` (STARTING | RUNNING | STOPPED | FAILED)
- `started_at`, `stopped_at`
- `last_error`

**`kv`** (optional)
- `key`, `value`, `updated_at`
- For misc state (last selected model, UI preferences, etc.)

### Static Config: `LLM/configs/llm_backends.yaml`

**What's in YAML now (static only)**:
- Model definitions (base_model, adapter_dir, model_type, use_4bit, system_prompt)
- "Preferred" port (hint only, actual runtime port is in StateStore)
- **NEVER rewritten at runtime** (YAML is version-controlled, deterministic)

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         OWLLM                                │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  llm_backends.yaml (STATIC CONFIG)                     │  │
│  │  - Model definitions (base_model, adapter, 4bit, etc.) │  │
│  │  - Preferred ports (hints only)                        │  │
│  │  - NEVER rewritten at runtime                          │  │
│  └────────────────────────────────────────────────────────┘  │
│                          │ read-only                          │
│                          ▼                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  data/owllm_state.db (RUNTIME STATE - SQLite)          │  │
│  │                                                          │  │
│  │  models: id, backend, path, env_key, params            │  │
│  │  envs: env_key, python, torch, cuda, status            │  │
│  │  servers: model_id, pid, port, status, timestamps      │  │
│  │  kv: misc state                                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                          ▲                                    │
│                          │ read/write                         │
│                          │                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  LLMServerManager                                       │  │
│  │  - Reads YAML for static config                        │  │
│  │  - Allocates ports at runtime                          │  │
│  │  - Persists to StateStore (not YAML)                   │  │
│  │  - Queries StateStore for current state                │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Benefits

✅ **No drift**: YAML never changes at runtime  
✅ **Queryable state**: Can ask "what's running?" at any time  
✅ **Persistent**: State survives restarts  
✅ **Atomic operations**: SQLite transactions ensure consistency  
✅ **Testable**: Can verify state directly from DB  
✅ **Concurrent-safe**: SQLite WAL mode supports multiple readers  

## Phase 1 Changes

### Files Modified
- `LLM/core/llm_server_manager.py`
  - Added StateStore integration
  - Port allocation stored in DB, not YAML
  - Server lifecycle tracked in `servers` table
  - `_save_config()` deprecated (now a no-op)

- `LLM/desktop_app/main.py`
  - `_resolve_model_id_from_path` adds models to StateStore
  - Still writes to YAML for backward compat, but marks port as "preferred"

### Files Created
- `LLM/core/state_store.py` - StateStore implementation
- `LLM/data/owllm_state.db` - SQLite database (created on first run)
- `docs/ARCH_STATE_MAP.md` - This document

### Migration Path
Existing systems with YAML-only state:
1. StateStore creates DB on first import
2. Server manager reads YAML (static config)
3. First server start populates StateStore with runtime state
4. Future starts check StateStore first, YAML second (fallback)

## Next Phases

### Phase 2: Per-stack environments (env_key)
- Replace per-model envs with shared env_key
- Atomic provisioning (.tmp → .envs rename)
- Constraints files for reproducibility

### Phase 3: Testing & CLI
- `owllm env test <env_key>`
- `owllm model smoke <model_id>`
- `owllm tools smoke <model_id>`
- pytest suite

### Phase 4: Tool calling (strict JSON)
- Remove XML/Python parsers
- Single JSON envelope + schema validation
- Stop sequences for clean tool output

## Acceptance Criteria

Phase 1 complete when:
- ✅ StateStore exists and is used by server manager
- ✅ YAML never rewritten at runtime
- ✅ Ports allocated at runtime and stored in DB
- ✅ Server lifecycle tracked in `servers` table
- ✅ No regressions: existing UI/servers/tools still work
