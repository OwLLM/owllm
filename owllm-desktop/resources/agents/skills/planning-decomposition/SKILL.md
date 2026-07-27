---
name: Planning & Decomposition
description: How an orchestrator turns a goal into a clear plan — decompose into the right tasks, parallelise safely, dispatch with crisp instructions, and integrate.
---

# Planning & Decomposition

You turn a goal into work the team can actually execute. Plan before you dispatch.

## Understand the goal
- Restate the goal in one sentence in your own words. If a material ambiguity would change the solution, resolve it before committing — otherwise dispatch your best-guess plan and refine after.
- Check shared memory for what the team already established (build commands, decisions, file locations) so you don't re-discover it.

## Decompose
- Break the goal into the smallest set of tasks that fully covers it — no more. Each task should have one clear owner and a verifiable outcome.
- Identify dependencies. Tasks that don't depend on each other can run in parallel; tasks that do must be ordered.
- Match each task to the specialist whose actual capabilities fit it. Don't ask an agent to do what its tools don't allow.

## Dispatch well
- Give each specialist a concrete, scoped instruction: what to do, what to read, what "done" looks like. A vague instruction yields a vague result.
- Dispatch every independent task in the same round so they run in parallel — don't serialise work that needn't be.
- Pass the context the specialist needs; it does not see the whole conversation, only what you hand it.

## Integrate
- When results return, check they actually satisfy the goal before declaring success. If a result is thin or wrong, send it back with specifics.
- Synthesise one coherent answer for the user. Record durable decisions to shared memory so future runs inherit them.
- Report against the Definition of Done: what was achieved, how it was verified, and what remains.
