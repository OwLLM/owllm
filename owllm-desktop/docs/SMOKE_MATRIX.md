# The Smoke Matrix — OWLLM's ship/no-ship gate

**Green matrix = shippable. Anything less = not.** `publish-release.sh` runs it
automatically before every build; a red cell aborts the publish.

```
node owllm-desktop/scripts/smoke-matrix.mjs              # full: static + harnesses + live providers + WSL
node owllm-desktop/scripts/smoke-matrix.mjs --static-only # fast: static + harnesses only (no credentials)
```

## Why this exists

Every provider bug of 2026-07 — kimi crashing on spawn (os error 206), kimi
`LLMNotSet`, kimi aborting on a dead MCP server, codex chasing a Claude-only
`ToolSearch`, claude's "command line too long", the spaced `--mcp-config` path,
the Code-page `unknown model_id` — shipped with a **green `cargo check` and a
green `tsc`**. Compilation proved nothing about whether an agent could actually
run. The user found each one in production.

The matrix closes that gap. It verifies the layer where those bugs lived: the
**process the app spawns** to talk to each provider. All three surfaces (Chat,
Code page, Agents team) converge on the same Rust functions in `accounts.rs` and
`mcp_gateway.rs`, so exercising the spawn shapes once covers all three.

## The four sections

**S — Static tripwires.** One source assertion per shipped regression fix, each
tagged with the bug and the version that fixed it. If a refactor deletes the
guard (e.g. removes `fold_prompt_into_stdin`), the tripwire goes red. Free,
instant, runs anywhere. This is the regression net: **when you fix a provider
bug, add a tripwire here** so it can never silently come back.

**H — Layer-1 harnesses.** Auto-discovers and runs every
`ui/src/pages/agentic/*.verify.run.mjs` (routing, gate, preflight, card-lint,
agent-prompt, ask-user). Pure control-flow logic, no model needed.

**P — Live provider cells.** One **real turn** per installed + logged-in CLI, at
the exact spawn shapes the Rust side builds:
- *small prompt* — the baseline (this is what the Accounts "Test" button does).
- *40 KB prompt via stdin* — over the 32 KB `CreateProcess` cap; only survives
  if the prompt is folded into stdin (the 206 fix). A regression here means full
  teams crash again.
- *MCP browser round-trip* — spins up a mock gateway (same bearer-auth
  streamable-HTTP dialect as the in-app one), wires it exactly as the app does
  (`--mcp-config` for claude/kimi, `-c mcp_servers.*` + env token for codex),
  and asserts the model actually **called `browser_snapshot` and got the result
  back**. A pass means the whole chain works: config → connect → auth →
  initialize → tools/list → tools/call → result in the reply.
- *kimi unreachable-MCP* — asserts kimi's fatal-abort text still matches what the
  Rust retry keys on; WARNs (not fails) if a kimi update makes it survive.

A provider that is **not installed or not logged in SKIPs with a reason** — never
a false FAIL. So the matrix is honest on any machine: it verifies what it can
reach and says plainly what it couldn't.

**W — WSL probes (advisory).** Interop reachability, CLIs visible on the
bwrap-jail PATH, kimi creds synced. WARNs rather than FAILs, because an
unprovisioned distro is an environment issue, not a code regression.

## In the publish flow

`publish-release.sh` runs the matrix as **step 0/5**, before the expensive
build, defaulting to `--static-only` (deterministic, no credentials — safe for a
headless/CI box). Toggles:

| Env | Effect |
|-----|--------|
| *(default)* | static tripwires + Layer-1 harnesses; red aborts the publish |
| `OWLLM_SMOKE_FULL=1` | also run the live provider cells (needs logged-in CLIs) |
| `OWLLM_SKIP_SMOKE=1` | bypass entirely — **emergencies only**, prints a warning |

Before shipping a release from a logged-in dev machine, run the **full** matrix
once by hand (`node owllm-desktop/scripts/smoke-matrix.mjs`) so the live provider
cells are exercised, not just the static net.

## Definition of done for v1.0

Full matrix green on two machines, and a real deliverable (e.g. a slide deck)
produced end-to-end by an agent team. Until then: not shippable.
