# OWLLM Bootstrap (Go)

Native install-time launcher. Runs *before* Python is installed, drives
the bundled supervisor (Gemma 4 E2B via llama.cpp) to install OWLLM
correctly on whatever hardware the user has.

Full design: [../../docs/supervisor/BOOTSTRAP.md](../../docs/supervisor/BOOTSTRAP.md)

## Status

**Skeleton.** This compiles, probes hardware, can spawn `llama-server.exe`,
and parses the structured plan the model returns -- but the action
executors (install_pkg, swap_wheel, ...) are stubs that log "would
execute X". Cutover order:

1. Build a tiny Windows installer that drops `bootstrap.exe` +
   `runtime/llama-server.exe` + `runtime/gemma-4-E2B-it-Q4_K_M.gguf` +
   `recipes/` and runs `bootstrap.exe` once.
2. Implement real action executors (one at a time, with E2E tests):
   `create_venv` -> `install_pkg` -> `download_file` -> `pick_profile`.
3. Wire telemetry so each install run feeds back into the failure corpus.
4. Ship as `OWLLM-Setup-AI.exe` (parallel installer flavor) per
   ROLLOUT.md Phase 6.

## Layout

```
bootstrap_go/
├── go.mod
├── main.go                 # entry point, plan loop
├── hardware/
│   └── probe.go            # nvidia-smi, wmic, dxdiag
├── server/
│   └── llama.go            # spawn + health + shutdown for llama-server
├── plan/
│   ├── plan.go             # Plan + Step types
│   └── parse.go            # tolerant JSON parser (mirrors Python brain.py)
└── exec/
    └── stubs.go            # action dispatch (stubbed for now)
```

## Build

Standard Go toolchain (>=1.22):

```powershell
cd LLM\bootstrap\bootstrap_go
go build -ldflags "-H=windowsgui" -o ..\bootstrap.exe .
```

The `-H=windowsgui` flag suppresses the console window so the user
doesn't see a flash on launch.

## Run

```powershell
# Manual run (after dropping the runtime artifacts):
python ..\runtime\download_runtime.py
..\bootstrap.exe --dry-run
```

`--dry-run` skips action execution but still spawns the model and
prints the proposed plan, useful for testing the wire format before
the executors are real.

## Why Go and not Rust

- Single static `.exe`, no MSVC redistributable dance.
- `os/exec` + `net/http` cover everything we need.
- We already have plenty of Python; a third systems language would be
  a maintenance burden.

## Cross-compilation

```powershell
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -ldflags "-H=windowsgui" -o ..\bootstrap.exe .
```

Same toolchain on macOS/Linux can build the Windows binary, which
matters for CI.
