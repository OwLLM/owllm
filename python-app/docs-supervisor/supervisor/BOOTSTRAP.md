# Bootstrap — install-time supervisor

## Goal

Get OWLLM installed and runnable on any Windows 10/11 machine with **zero Python pre-installed**, no internet required for the model itself, and intelligent recovery from the failures we currently see ("requirements break again and again").

## Why a native bootstrap

The existing installer (`installer_v2.py`, `installer_gui.py`) needs Python to run. That's exactly the chicken-and-egg the user called out: if Python install fails, our Python-based recovery can't run. So we ship a small native binary that runs *before* anything Python touches the disk.

## Layout

```
LLM/bootstrap/
├── bootstrap.exe                       # native launcher (~5 MB)
├── runtime/
│   ├── llama-server.exe                # static llama.cpp build (~3 MB)
│   └── gemma-4-E2B-it-Q4_K_M.gguf     # ~1.5 GB
├── recipes/
│   ├── hardware_profiles.json          # known-good cold-start combos
│   ├── failure_corpus.jsonl            # fine-tune dataset (built up over time)
│   └── system_prompt.txt               # supervisor system prompt
└── wheels/                             # optional pre-staged wheel cache
```

## Implementation choice

**Language for `bootstrap.exe`**: Go or Rust.

- **Go** — easier, faster to write, single static `.exe`, good `os/exec` story.
- **Rust** — smaller binary, more careful error handling.

Recommend **Go**: lower friction for the install-time use case where ergonomics matter more than binary size, and we already have lots of Python — a second non-trivial language is enough.

## Boot sequence

```
1. user launches OWLLM-Setup.exe (NSIS or similar) which extracts:
   - bootstrap.exe + runtime/ + recipes/ to %LOCALAPPDATA%\OWLLM\bootstrap\
   - app payload to %LOCALAPPDATA%\OWLLM\app\
   - python_runtime/ NOT YET — installed by bootstrap
   then runs bootstrap.exe

2. bootstrap.exe:
   a. probe hardware
      - nvidia-smi (parse JSON if available)
      - wmic path Win32_VideoController
      - dxdiag /t for fallback
      - WMI/PowerShell for RAM, disk, CPU
   b. build hardware_spec.json
   c. spawn llama-server.exe --model ..\runtime\gemma-4-E2B-it-Q4_K_M.gguf
              --port 8765 --ctx-size 16384 --grammar-file plan.gbnf
   d. wait for /health to be 200

3. ask the model:
      input  = { hardware_spec, install_goal: "owllm-3.0", recipes_summary }
      output = { profile: "cuda121-torch25",
                 steps: [ {action, args}, ... ] }

4. for each step:
      execute via tool dispatcher
      on success: log + next
      on failure: feed stderr back to model → next-best action
      bounded retry (max 5 per step)
      on full failure: surface to user with model's diagnosis

5. when done:
      - python_runtime/ installed and seeded
      - venv created
      - core deps installed
      - app launchable
   bootstrap.exe gracefully shuts down llama-server.exe (POST /shutdown,
   then SIGTERM, then SIGKILL after 5s) before exiting. The desktop app
   respawns llama-server on demand the first time a runtime failure event
   arrives -- see "Model lifecycle" below.
```

## Hardware probe

Output schema (consumed by both bootstrap and runtime):

```json
{
  "os": { "name": "Windows", "version": "10.0.19045", "arch": "x64" },
  "cpu": { "model": "Intel i7-9700K", "cores": 8, "threads": 8 },
  "ram_gb": 32,
  "disk_free_gb": 412,
  "gpu": [
    {
      "vendor": "nvidia",
      "model": "RTX 3060",
      "vram_gb": 12,
      "driver": "551.86",
      "cuda_runtime": "12.4",
      "compute_capability": "8.6"
    }
  ]
}
```

## Plan grammar (GBNF)

The model is constrained to JSON output via llama.cpp's GBNF grammar. Skeleton:

```gbnf
root        ::= "{" ws "\"profile\":" ws string "," ws "\"steps\":" ws steps ws "}"
steps       ::= "[" ws (step ("," ws step)*)? ws "]"
step        ::= "{" ws "\"action\":" ws action "," ws "\"args\":" ws object "}"
action      ::= "\"install_pkg\"" | "\"swap_wheel\"" | "\"set_env\""
              | "\"download_file\"" | "\"create_venv\"" | "\"run_shell\""
              | "\"pick_profile\"" | "\"abort\""
```

This guarantees the model literally cannot return malformed actions — any output that fits the grammar is safe to dispatch.

See [TOOLS.md](TOOLS.md) for the full action surface.

## Cold-start recipe table

`recipes/hardware_profiles.json` is a small set of known-good profiles for the common cases. The bootstrap consults this *before* asking the model — if hardware matches a known happy path, skip the model call entirely. Faster for the 80% case, model handles the 20% tail.

Skeleton schema:

```json
{
  "profiles": [
    {
      "id": "cuda121-torch25",
      "match": {
        "gpu.vendor": "nvidia",
        "gpu.cuda_runtime": ">=12.1,<13.0",
        "gpu.compute_capability": ">=8.0"
      },
      "steps": [
        { "action": "create_venv", "args": { "python_version": "3.11" } },
        { "action": "install_pkg", "args": { "name": "torch==2.5.1+cu121",
                                              "index": "https://download.pytorch.org/whl/cu121" } },
        { "action": "install_pkg", "args": { "name": "bitsandbytes==0.44.1" } }
      ]
    }
  ]
}
```

## Model lifecycle

**Decided:** llama-server is shut down by bootstrap when install completes;
the desktop app respawns it on demand.

Why:
- Clean ownership. The process that started llama-server owns it. Bootstrap
  doesn't hand off a live process to a child it didn't fork.
- Crash recovery is trivial: if llama-server dies, the desktop app
  respawns it the next time it's needed. No "is the inherited process
  still alive?" plumbing.
- Memory cost. The bundled E2B holds ~1.5 GB resident even when idle.
  Releasing it after install lets the user reach the desktop tray with
  ~1.5 GB more free RAM until the supervisor is actually needed.
- The cost is one ~8 sec cold start the first time a runtime failure
  event triggers the supervisor in a session. The supervisor is event-
  driven (not on the hot path), so this is acceptable.

How the desktop app respawns it:
- `core/supervisor/brain.py` checks `/health` before each request.
- If unhealthy, it spawns `bootstrap/runtime/llama-server.exe` with the
  same args bootstrap used (model path, port 8765, ctx 16384, grammar
  file). Spawn is hidden via the existing Windows subprocess guard.
- After 5 minutes idle, the desktop app sends `/shutdown` to free RAM.
  The next failure event respawns it -- same 8 sec cold start, fine.

## Distribution sizing

| Component | Size | Notes |
| --- | --- | --- |
| bootstrap.exe | ~5 MB | static Go binary |
| llama-server.exe | ~3 MB | llama.cpp release build |
| gemma-4-E2B-it-Q4_K_M.gguf | ~1.5 GB | the brain |
| recipes/ | <1 MB | JSON + GBNF + prompt |
| **Total bundled** | **~1.5 GB** | |

To keep the installer small: ship a 50 MB stub installer that downloads the GGUF on first run with a progress bar (Stage-2 installer pattern).

## Open questions

- If user has no GPU, do we install CPU-only torch profile or refuse? (Refuse is mean -- install CPU profile and warn.)
- What happens if `bootstrap.exe` itself crashes? Need a tiny watchdog or just rely on user re-launching the installer.
- Wheel cache strategy: pre-stage common wheels in `wheels/` (adds ~500 MB) vs. always download from PyPI/pytorch.org (faster installer, breaks offline install).
