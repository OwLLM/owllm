# Supervisor Architecture

## Problem

OWLLM has a combinatorial install/runtime failure space: GPU × driver × CUDA × torch × bitsandbytes × model format × dataset shape. Rule-based recovery (`if cuda == "12.1" and torch == "2.4" then …`) keeps breaking — every new GPU/driver/release combo is a new bug.

## Solution

A small fine-tuned LLM (Gemma 4 E2B) acts as the diagnostic brain. It receives structured inputs (hardware spec, error log, current state) and emits structured actions (install package X, swap wheel, set env var, pick profile Y, normalize dataset). A bounded executor runs those actions and feeds outcomes back. The model improves over time as new failures get added to the fine-tune corpus.

## Two operating modes

The supervisor runs in **two modes**, sharing the same model and tool surface:

### 1. Bootstrap mode (install-time)

A native launcher (`bootstrap.exe`) runs *before* Python is installed. It:

1. Probes hardware (GPU, driver, VRAM, CUDA, RAM, disk).
2. Spawns the bundled `llama-server.exe` with the bundled E2B GGUF.
3. Asks the model: given this hardware, what install profile + steps?
4. Executes the plan (download wheels, build venv, install in dependency-safe order).
5. On any step failure, feeds stderr back to the model → next-best action. Bounded retry.

No Python required. No internet required (model + minimal wheel cache shipped or staged on first run).

See [BOOTSTRAP.md](BOOTSTRAP.md) for details.

### 2. Runtime mode (post-install)

Once the main app is up, `core/supervisor/brain.py` subscribes to the agent bus (`core/agents/bus.py`). Failure events from training, inference, dataset validation, and runtime probes are routed to the supervisor, which respawns `llama-server.exe` on demand (bootstrap shuts it down on install completion -- see [BOOTSTRAP.md](BOOTSTRAP.md#model-lifecycle)) and proposes a fix. The fix is gated by a UI toast ("Apply fix?") by default -- the user can toggle "auto-approve safe fixes" later. Server idles out after 5 minutes to free ~1.5 GB RAM; next failure respawns it.

See [EVENTS.md](EVENTS.md) for the event contract.

## Component map

```
┌──────────────────────────────────────────────────────────────────┐
│  bootstrap.exe (native, ~5 MB)                                   │
│   ├─ hardware probe (nvidia-smi, wmic, dxdiag)                   │
│   ├─ spawns llama-server.exe                                     │
│   └─ executes plan returned by model                             │
└──────────────────────────────────────────────────────────────────┘
                               │
                               │ HTTP (localhost)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  llama-server.exe + gemma-4-E2B-it-Q4_K_M.gguf  (~1.5 GB)        │
│   - GBNF grammar-constrained JSON output                         │
│   - 128K context                                                 │
└──────────────────────────────────────────────────────────────────┘
                               ▲
                               │ HTTP (localhost) — same server, reused
                               │
┌──────────────────────────────────────────────────────────────────┐
│  core/supervisor/  (Python — runtime mode)                       │
│   ├─ brain.py          → HTTP client to llama-server             │
│   ├─ tools.py          → install_pkg, swap_wheel, fix_dataset…   │
│   ├─ event_bus.py      → subscribes to core/agents/bus.py        │
│   ├─ hardware_probe.py → reuse for runtime re-probes             │
│   └─ profile_selector.py → LLM-driven (replaces rule version)    │
└──────────────────────────────────────────────────────────────────┘
                               │
                               │ events
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Existing OWLLM components emit failures:                        │
│   - core/training.py (finetune crashes)                          │
│   - core/inference.py (model load probe)                         │
│   - core/runtime/self_heal_orchestrator.py (kept as executor)    │
│   - desktop_app/training_widgets.py (dataset validation)         │
└──────────────────────────────────────────────────────────────────┘
```

## Data flow — one failure round

```
event (training_failed)
   │
   ▼
┌──────────────────────────────────────────────────┐
│ event_bus.py: collect context                    │
│  { hardware, error_log[-200 lines], current_env, │
│    last_actions, retry_count }                   │
└──────────────────────────────────────────────────┘
   │
   ▼  HTTP POST /completion (with GBNF grammar)
┌──────────────────────────────────────────────────┐
│ Gemma 4 E2B returns:                             │
│  { action: "install_pkg",                        │
│    args: { name: "bitsandbytes", version: …},    │
│    reason: "torch 2.5 needs bnb >= 0.44",        │
│    fallback: "swap_wheel:torch:2.4.1+cu121" }    │
└──────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────┐
│ tools.py executes action                         │
│  - shows UI toast (gated by default)             │
│  - on success: emit event(fix_applied)           │
│  - on fail: feed stderr back, try fallback       │
│  - bounded: max 5 attempts per failure           │
└──────────────────────────────────────────────────┘
```

## Why this beats rules

- Generalizes to GPU/driver combos never seen before.
- New failures become training data, not new `if` branches.
- The cold-start `hardware_profiles.json` recipe table is small (just well-known happy paths) — the model handles the long tail.

## Why not cloud-only

- Install-time runs before any Python or network stack is guaranteed.
- User's machine may be offline.
- Some users won't accept telemetry/error logs leaving their machine.
- A bundled model's behavior is reproducible; a remote API's is not (it can drift).

A cloud fallback (Claude API via [claude_api.py](../../core/agents/backends/claude_api.py)) is a *future* opt-in for users who want extra accuracy on hard failures.

## Replacement scope

These modules become thin executors instead of decision-makers:

| Module | Today | After |
| --- | --- | --- |
| [profile_selector.py](../../core/profile_selector.py) | rule table mapping hardware → profile | LLM-driven, with hardcoded happy-path cache |
| [capability_matrix.py](../../core/envs/capability_matrix.py) | rule classifier for failure → category | replaced by model output schema |
| [self_heal_orchestrator.py](../../core/runtime/self_heal_orchestrator.py) | hardcoded remediation steps | exposes its existing recovery primitives as supervisor *tools* |

Existing recovery primitives (runtime bundle repair, missing-package install, model probe rerun) are kept — they become **tools the model can call**, not the decision logic itself.

## Open design questions

- Model update channel -- auto-update the GGUF separately from app releases?
- Telemetry: opt-in upload of failure->fix outcomes to feed the next fine-tune?
- Trust boundary: what tools require user confirmation vs. fully auto?

These are tracked in their respective docs.

(Resolved: llama-server lifecycle -- bootstrap shuts down, app respawns on demand. See [BOOTSTRAP.md](BOOTSTRAP.md#model-lifecycle).)
