# Event Bus Contract — runtime supervisor

How the supervisor learns about failures during normal app use.

## Reuses existing bus

OWLLM already has [core/agents/bus.py](../../core/agents/bus.py) — an in-process pub/sub bus with SQLite-persisted log and Qt-safe fanout. The supervisor subscribes to it; we don't build a parallel system.

## New event kinds

We add these `MessageKind` values (or analogous structured events) for failure signals:

| Event kind | Emitted by | Payload |
| --- | --- | --- |
| `runtime_probe_failed` | `core/inference.py` model probe | `{model_path, reason_code, error_message, hardware_spec}` |
| `training_failed` | `core/training.py` / `finetune.py` | `{run_id, dataset_path, model_path, error_log_tail, exit_code}` |
| `dataset_invalid` | `desktop_app/training_widgets.py` validator | `{path, expected_format, actual_format, sample_rows}` |
| `install_step_failed` | bootstrap or `pip_worker.py` | `{action, args, exit_code, stderr_tail}` |
| `mcp_server_crashed` | `desktop_app/mcp/server_manager.py` | `{server_id, exit_code, stderr_tail}` |
| `gpu_oom` | training/inference loops | `{stage, model_size, batch_size, vram_gb}` |

These are **structured** — never just a free-text string. The supervisor needs schema to reason; bug reports need schema to be searchable.

## Subscription flow

```python
# core/supervisor/event_bus.py
from core.agents.bus import get_bus
from core.supervisor.brain import Brain

def install():
    bus = get_bus()
    brain = Brain()  # connects to llama-server
    bus.subscribe(lambda msg: _route(msg, brain))

FAILURE_KINDS = {
    "runtime_probe_failed", "training_failed", "dataset_invalid",
    "install_step_failed", "mcp_server_crashed", "gpu_oom",
}

def _route(msg, brain):
    if msg.kind not in FAILURE_KINDS:
        return
    plan = brain.diagnose(msg)
    Executor().run(plan, on_finish=lambda result: bus.publish(_outcome_msg(result)))
```

Subscribers run on the publishing thread per the bus's threading model — `_route` MUST hand off quickly. The brain call goes to a worker thread or asyncio task; the subscriber callback only enqueues.

## Outcome events

Once the supervisor acts, it emits its own events so the UI and audit log can track it:

| Event kind | Payload |
| --- | --- |
| `supervisor_diagnosed` | `{trigger_id, action, args, reason, fallback}` |
| `supervisor_fix_proposed` | same — gated waiting for user confirm |
| `supervisor_fix_applied` | `{trigger_id, action, ok, side_effects}` |
| `supervisor_gave_up` | `{trigger_id, reason, attempts}` |

The `supervisor_page.py` renders the live stream of these. The `failure_corpus.jsonl` builder (see [FINETUNE.md](FINETUNE.md)) consumes them as labeled examples.

## Context window — what gets sent to the model

For each failure, the brain assembles:

```json
{
  "trigger": { "kind": "training_failed", "...payload": "..." },
  "hardware": { "...same as bootstrap...": "" },
  "current_env": {
    "python": "3.11.9",
    "torch": "2.5.1+cu121",
    "bitsandbytes": "0.44.1",
    "...": ""
  },
  "recent_actions": [ "...last 5 supervisor actions..." ],
  "error_log_tail": "...last 200 lines of stderr..."
}
```

128K context (E2B / E4B) means we rarely need to truncate. Default is `tail -200` of stderr; the model can call `read_log` if it needs more.

## Throttling / loop prevention

- **Per-trigger budget:** max 5 supervisor actions per trigger event.
- **Global rate limit:** max 1 active supervisor session at a time. New failures during an active session queue up.
- **Failure deduplication:** identical failures within 60s are coalesced (don't keep retrying when the underlying cause hasn't changed).
- **Cool-down on repeated gave-up:** if supervisor gives up on the same failure 3 times in 24h, stop retrying and surface a permanent "ask the user" banner.

## Privacy

All events stay local. Optional opt-in upload feeds the next fine-tune corpus — see [FINETUNE.md](FINETUNE.md#telemetry-and-corpus-growth). User must explicitly enable, and the upload UI shows exactly what's in the payload.
