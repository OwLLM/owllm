"""Subscribe the supervisor to OWLLM's existing agent bus.

See LLM/docs/supervisor/EVENTS.md for the failure-event contract.

Skeleton. Wire-up plan:
- install() subscribes a routing callback to core.agents.bus.get_bus().
- _route(msg, brain, executor) filters for FAILURE_KINDS, asks the brain for
  a plan, hands off to the executor on a worker thread (the bus subscriber
  callback runs on the publishing thread and MUST return quickly).
- Outcome events are published back to the same bus so the supervisor page
  and audit log see the full lifecycle.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.supervisor.brain import Brain


FAILURE_KINDS = frozenset({
    "runtime_probe_failed",
    "training_failed",
    "dataset_invalid",
    "install_step_failed",
    "mcp_server_crashed",
    "gpu_oom",
})


def install(brain: "Brain") -> None:
    """Subscribe the supervisor to the global agent bus.

    Idempotent — calling twice in the same process is a no-op.
    """
    raise NotImplementedError("Skeleton — see LLM/docs/supervisor/EVENTS.md")
