# OwLLM Desktop — Tauri command API

The React UI talks to the Rust backend via Tauri `invoke()` only. There
is no HTTP server, no localhost proxy, no Python daemon. The deleted
HTTP API surface (a `python_engine` HTTP server on port 18765) is
described in the historical note at the bottom.

## Native Tauri commands (current)

All defined in `src-tauri/src/lib.rs`. Invoke from React via
`@tauri-apps/api/core::invoke`.

### `list_models() -> Vec<ModelInfo>`

Returns the configured model registry. **Stub today** (returns an
empty list); next pass scans a known models directory and returns:

```ts
type ModelInfo = {
  model_id: string;
  port?: number | null;
  base_model?: string | null;
};
```

### `server_status() -> ServerStatus`

Current model-server state. **Stub today**; next pass tracks the
spawned llama.cpp child PID natively.

```ts
type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};
```

### `server_start(modelId: string) -> Result<(), String>`

Start the model server for the given model id. **Stub today**; next
pass spawns the llama.cpp binary from Rust with `CREATE_NO_WINDOW`
so no console pops on Windows.

### `server_stop() -> Result<(), String>`

Stop the running model server. **Stub today** — no spawned child to
kill yet. Always returns `Ok(())`.

### `hardware_info() -> HardwareInfo`

Hardware probe. **Stub today**; next pass uses the `sysinfo` crate
plus NVML for GPU detection.

```ts
type HardwareInfo = {
  cpu_name: string;
  cpu_cores: number;
  ram_gb: number;
  gpus: Array<{ index: number; name: string; vram_gb: number }>;
};
```

## Implementation roadmap

The stubs above are the minimal contract the React UI compiles against.
Each gets a native Rust implementation in subsequent commits:

1. `list_models` — read a models directory, parse JSON registries.
2. `hardware_info` — `sysinfo` crate + NVML/wmic GPU probe.
3. `server_start` / `server_stop` / `server_status` — `tokio::process::Command`
   with `creation_flags(CREATE_NO_WINDOW)` on Windows. Tracked PID per
   model, child stdout/stderr piped to a Tauri event channel.
4. Per-tab commands as each React page is wired up (bridges,
   accounts, MCP catalog/connections/tools).

## Historical note (deleted)

An earlier draft of this app shipped a bundled Python HTTP server
(`python_engine/owllm_engine/server.py`) on `127.0.0.1:18765` and four
Tauri proxy commands (`engine_get`, `engine_post`, `engine_start`,
`engine_stop`). That was wiped on 2026-05-14 because it violated the
agreed-upon architecture (Rust+React, Python only on-demand for
fine-tuning) and was the source of every console popup at app
startup. The HTTP endpoints that used to live there (e.g.
`GET /v1/models`, `POST /v1/server/start`) are being re-implemented
as the native Tauri commands above.
