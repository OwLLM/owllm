# OWLLM-Setup-AI.exe

NSIS-based installer for the AI-driven flavor, parallel to the
classic Python-based `OWLLM-Setup.exe`. Ships:

- `bootstrap.exe` (Go, headless, hidden console)
- `runtime/llama-server.exe` (llama.cpp release build)
- `runtime/gemma-4-E2B-it-Q4_K_M.gguf` (~1.5 GB, the bundled supervisor brain)
- `recipes/` (system prompt, GBNF grammar, hardware-profile table)

## Build

The full chain is wrapped by [../build_installer.bat](../build_installer.bat).
It does:

1. `python ../runtime/download_runtime.py` -- fetches `llama-server.exe`
   and the GGUF if missing.
2. `cd ../bootstrap_go && go build -ldflags "-H=windowsgui" -o ../bootstrap.exe .`
3. `makensis OWLLM-Setup-AI.nsi`

Prerequisites:

- Go 1.22+ on PATH
- NSIS 3.x on PATH (`makensis` available as a command)
- Internet (only for the first run, to fetch the runtime artifacts)

## Install layout (per-user)

```
%LOCALAPPDATA%\OWLLM\bootstrap\
  bootstrap.exe
  runtime\
    llama-server.exe
    gemma-4-E2B-it-Q4_K_M.gguf
    bootstrap_env.json     (created by set_env executor)
    pending_question.json  (created by ask_user executor)
  recipes\
    hardware_profiles.json
    plan.gbnf
    system_prompt.txt
  Uninstall.exe
```

## After install

The installer auto-launches `bootstrap.exe` once at the end. From
there the supervisor (Gemma 4 E2B) drives the Python venv creation
and dependency install. See [../docs/supervisor/BOOTSTRAP.md](../docs/supervisor/BOOTSTRAP.md)
for the full sequence.

## Phase rollout

This installer flavor is opt-in (Phase 6 in
[../docs/supervisor/ROLLOUT.md](../docs/supervisor/ROLLOUT.md)). The
classic `OWLLM-Setup.exe` continues to ship as the default until
the AI flavor matches or beats it on telemetry-measured install
success rate (Phase 7 cutover criterion).
