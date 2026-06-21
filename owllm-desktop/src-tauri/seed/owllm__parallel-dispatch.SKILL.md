---
name: parallel-dispatch
description: Use when the user's goal has 2+ INDEPENDENT subtasks (no shared files, no output dependency) so you dispatch them as one concurrent wave instead of one agent at a time.
icon: parallel
leader: true
---

# Parallel Dispatch (OWLLM orchestrator)

Your team's agents run CONCURRENTLY. Every `@agent: task` line you emit IN ONE REPLY
runs at the SAME TIME, each in its own isolated git worktree that auto-merges when it
finishes. One `@agent:` line per reply runs sequentially. Use this to move faster.

## When to parallelize

Two tasks are INDEPENDENT — safe to run in the same wave — only when BOTH hold:

1. Neither needs the other's output.
2. They touch DIFFERENT files/areas (no shared state).

The team graph already encodes dependencies: an arrow A → B means B depends on A, so
sequence them. No arrow between two agents = independent = parallel-safe.

- Independent → dispatch them TOGETHER in one reply (one wave).
- Dependent (B needs A's result) → dispatch A now, then B next turn with A's output.
- Unsure / exploratory / "fixing one might fix the others" → start with ONE agent.

## How to write a parallel task

Each agent runs with ISOLATED context — it never sees the other agents' work or this
conversation. So make every dispatched task SELF-CONTAINED:

- **Scope:** exactly which file / area / subsystem.
- **Goal:** what "done" looks like.
- **Constraints:** e.g. "edit only X; do not refactor Y; tests only".
- **Expected output:** what to report back so you can integrate it.

## Avoid collisions

Parallel agents commit in separate worktrees that merge back. Two agents editing the
SAME file in one wave WILL conflict at merge. Split the wave so each agent owns
different files; if two tasks must touch the same file, sequence them instead.

## After a wave

When the wave returns: read each agent's summary, confirm the worktree merges didn't
conflict, integrate, then dispatch the next wave (or write the final answer).

## Common mistakes

- ❌ "Fix everything" to one agent → it loses focus. ✅ One agent per problem domain.
- ❌ Vague task with no output spec. ✅ State exactly what to return.
- ❌ Two parallel agents on the same file. ✅ Different files per wave, or sequence.
- ❌ Many single-agent turns for independent work. ✅ One wide wave.
