# Build Shape — Slice 1 Spec (buildable)

Goal: turn the Build Shape from prose into a working default — **Lead + always-on
Verification Gate + activate-roles + one real per-agent verify loop** — without
breaking the current dispatch. Ship behind the existing team path; prove on a real
task; then retire the redundant coding teams.

## Roster
- **Always present:** Lead/Orchestrator · Verification Gate (infrastructure, not an agent).
- **Activated when needed:** Frontend Coder · Backend Coder · Tester · Critic · Red Team · Publisher · Critical Thinker (plan stage).

## Activation table (Lead decides; Gate corrects under-activation)
| Task | Activates |
|---|---|
| single-lane edit (UI-only / backend-only) | Lead + that one Coder + Gate |
| cross-lane feature | Lead + Critical Thinker (plan) + Frontend + Backend + Gate + Critic |
| + new tests needed | + Tester |
| + security-sensitive | + Red Team |
| + user asked to ship | + Publisher |

## Verification Gate (the load-bearing piece — build this first)
- **Mandatory, always runs *something*** when files changed. Reuses the sandbox-aware shell (already shipped in v0.6.78 run-end verify).
- Config: `.owllm/verify.json` → `{ "command": "npm run build", "lanes": { "frontend": "npm run build", "backend": "pytest -q" } }` (lane keys optional).
- **Scales to the task:** lightweight check for a 1-line change (typecheck/lint/affected build); full command for a feature.
- **Degrades honestly:** no `verify.json` and no detectable tests → report **"unverified — no check configured"** (NOT "passed", NOT a hard block).
- **Captured, not claimed:** stores real stdout/stderr + exit code; "done" is decided from the exit code, never from an agent's text.
- One abstraction `Gate.run(cwd, scope) → {passed|unverified, command, output}`; the Build face = tests/build.

## Per-agent scoped loop (build for the Coder first)
```
read task + shared contract
→ find the real code itself (grep/read) — never act on an unconfirmed pointer
→ edit
→ run its lane check (the Gate, scoped to its lane)
→ if fail & progress: read failure, fix, retry
→ if "same error twice" OR "needs other lane": STOP → escalate (don't retry)
→ return STRUCTURED HANDOFF
```
Loop budget (per agent): `max_iterations: 3` (cap), `stop_when: lane check passes`, `escalate_when: [same error twice, contract mismatch, needs other lane]`. Primary exit is **no-progress**, not the cap.

## Structured handoff (replaces "I finished")
```json
{
  "agent": "frontend-coder",
  "contract_version": "c-2026-06-28-001",
  "files_changed": ["src/pages/Dashboard.tsx"],
  "lane_check": { "command": "npm run build", "result": "passed", "captured": true },
  "assumptions": ["GET /api/projects returns {id,name,createdAt}"],
  "contract_change_requests": [],
  "ready_for_integration": true
}
```
`lane_check.result` is filled by the **Gate**, not the agent.

## Contracts
- **No fan-out without a locked contract** for cross-lane work: Lead drafts contract → Critical Thinker reviews → lock → write to **shared contract memory** (team_memory key `contract`).
- **No silent contract change:** a coder needing an endpoint/schema/auth change emits a `contract_change_request` instead of editing it; Lead re-locks + re-dispatches the affected lane **once**. Second change on the same feature → escalate to human (contract-revision budget = 1).

## Integration verify
Cross-lane: merge lane patches into an **integration worktree** → run the **full** Gate on the merged tree (build + integration tests) → only then Critic (grounded by that output) → Publisher.

## Memory mapping (reuse what exists; add minimally)
- Tier 1 private → existing per-agent memory ✓
- Tier 2 contract → team_memory key `contract` (add discipline)
- Tier 5 artifact/logs → existing eval-traces + the Gate's captured output ✓
- Tiers 3 (blackboard) + 4 (decision log) → **defer to slice 2** (lightweight JSON in team_memory).

## Build order
1. **Gate** as a first-class function (scale + honest-degrade + captured result + lane scope). *Highest leverage; everything reuses it.*
2. **Coder per-agent loop** (read→act→lane-gate→fix→stop, budget 3, no-progress exit, structured handoff). Prove a single-lane task runs solo + gate.
3. **Activation table** in the Lead (default solo single-lane; expand on cross-lane).
4. **Contract lock + change-request** for cross-lane; **integration worktree + full Gate**.
5. Then: collapse the 5 coding teams into this one "OWLLM Team" preset; retire the redundant 4 (confirm before deleting).

## Acceptance criteria
- Single-lane task: Lead + one Coder + Gate; Run Report shows the real check ✓/✗ (or "unverified").
- Cross-lane task: contract locked before fan-out; integration Gate runs on the merged tree; Critic reads the Gate output.
- No `verify.json`: honest "unverified", not false "passed", not blocked.
- A failing lane check that repeats the same error escalates instead of looping.
- `tsc --noEmit` baseline unchanged; harness (routing.verify) green.
