# OwLLM Engine HTTP API (MVP)

Base URL: `http://127.0.0.1:18765` (override with `OWLLM_ENGINE_HOST` / `OWLLM_ENGINE_PORT`)

## Endpoints

### `GET /health`

Returns `{ "ok": true, "service": "owllm_engine" }`.

### `GET /v1/hardware`

Best-effort hardware detection via `system_detector.SystemDetector`.

### `GET /v1/envs`

Lists environments via `core.envs.env_registry.EnvRegistry` (defensive; schema may evolve).

### `GET /v1/models`

Reads `configs/llm_backends.yaml` via `core.inference.get_app_root()`.

### `GET /v1/server/status?model_id=...`

Returns StateStore server row for the model id (best-effort).

### `POST /v1/server/start`

Body:

```json
{ "model_id": "..." }
```

Calls `LLMServerManager.ensure_server_running(model_id)`.

### `POST /v1/server/stop`

Body:

```json
{ "model_id": "..." }
```

Calls `LLMServerManager.shutdown_server(model_id)`.

## Stubs (incremental migration)

These exist to keep the UI/Rust contract stable while workflows are ported:

- `GET /v1/onboarding/status`
- `POST /v1/env/repair`
- `GET /v1/mcp/status`
- `GET /v1/tools/status`
- `GET /v1/training/status`
- `GET /v1/logs/tail?max_lines=100`
