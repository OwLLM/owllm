# Test-validation agent — requirements & design notes

Author: Claude (the assistant doing OWLLM development), 2026-05-10.

## Why this document exists

When a user reports a bug like

> `Team: run failed: ... Cannot find module '/workspace/C:\Users\mc\AppData\Roaming\npm\claude.cmd'`

the right loop is:

1. read the error
2. **reproduce it locally** with a minimal test
3. fix it
4. verify the fix kills the repro
5. ship

I can do steps 1, 3, and 5. **I cannot do steps 2 and 4** for a large class of OWLLM bugs because the failure surfaces only inside a running Docker container, a live PySide6 GUI, an authenticated Claude/Codex session, or the actual claude.ai backend. So today the loop becomes:

1. read the error
2. *guess* a fix from the stack trace
3. ship to the user
4. wait for the user to re-run and paste the next error
5. repeat

That's the iteration cost the user has been (rightly) frustrated by. The "test-validation agent" described below is designed to give me steps 2 and 4 directly so I can converge on fixes inside one round trip instead of N.

This is not a request to build the agent immediately. It is a comprehensive spec the user and I will work on later.

---

## What I cannot test from my current environment

A concrete inventory, with the bug each gap recently produced.

### Gap 1 — Live Docker container execution

**What's blocked:** I cannot run `docker run owllm/agent:abc1234 claude --print "hi"` from my sandbox. I cannot observe what the container's stdout/stderr looks like. I cannot bind-mount real auth dirs into a real Linux filesystem and watch what Claude Code does on startup.

**Bugs this gap produced:**

- `d094b68` — argv[0] was the host's Windows `.cmd` path, container couldn't execute it. I had to wait for the user to run the team and paste the failure before I knew it was an argv issue.
- `e96ff7a` — the container had `~/.claude/` mounted but not `~/.claude.json`, so Claude Code reported "config file not found" inside the container. I missed this because nothing in the static code told me which files claude-code reads on startup.

If I could execute the container locally with a controlled `~/.claude` payload, I'd have caught both in seconds.

### Gap 2 — PySide6 GUI rendering and interaction

**What's blocked:** I can't see the canvas. I can't tell whether nodes are clipped, whether arrows look ugly, whether the layout actually right-aligns. I can't drive interactions like "click Layout, then verify the bounding box ends up against the right edge".

**Bugs this gap produced:**

- `05fd19a` — `centerOn(target.right - half_vp)` was being silently clamped by Qt because the scene rect was tight around the items. The user had to send screenshots showing the layout in the wrong position. If I'd run the GUI offscreen with `QT_QPA_PLATFORM=offscreen` and rendered the canvas, I'd have measured the bounding box vs. viewport position and seen the misalignment.
- The "ugly arrows" → "tight cascade" → "still ugly cascade" → "you missed parent-anchor" → "still tight column" → "actually it's the diag step, here's the spec" sequence (commits `424843d` → `8e008e1` → `4df4200` → `7dcc4b3` → `3274013` → `05fd19a`). Six iterations because I was guessing at what "looked right" rather than rendering and measuring.

### Gap 3 — Authenticated CLI calls

**What's blocked:** I have no Claude.ai session, no Codex session, no OpenAI API key, no Anthropic API key, no real Telegram bot token. I cannot exercise any backend that requires real auth. Even if I could spin up containers, every CLI invocation would fail at the auth gate.

**Bugs this gap produced:**

- All of the recent container plumbing — I've been writing fixes blind to whether `~/.claude.json` mounted RO works, whether token refresh inside the container succeeds, whether the codex auth shape on Windows is what I assumed.

### Gap 4 — Live LLM behavior

**What's blocked:** I cannot run an agent loop and see what the orchestrator actually says in response to a goal. The model's output drives downstream branching (does it dispatch to coder? does it ask the user a clarifying question? does it call `recall`?). I can read the prompts and tools but I can't see the *behavior*.

**Bugs this gap produced:**

- The original-goal eviction bug (drop-oldest fallback in `_build_messages` evicting index 0). I diagnosed it from a transcript the user pasted. With a synthetic "5-step coding task" repro that I could run end-to-end, I'd have caught it without the user noticing in production.
- The "orchestrator forgot the goal" pattern in general — I don't know whether my fixes actually solved it or just delayed it, because I never re-run the team to verify.

### Gap 5 — Long-running / background process state

**What's blocked:** I cannot observe what `llm_server_start.py` does as it spawns a llama-server. I cannot see whether the supervisor brain auto-spawns. I cannot watch the bus log evolve as a goal progresses. I cannot tell if a fleet broker claim leaks.

**Bugs this gap produced:**

- The mystery `gemma-4-E4B-it-Q5_K_M.gguf` server starting on its own. I had to ask the user to run `Get-CimInstance Win32_Process | ...` to inspect parent PIDs. With access to a live snapshot of running OWLLM processes + their parent chains, I'd have answered "auto-resume from last session" in one turn.

### Gap 6 — Long-running interactive flows

**What's blocked:** anything that needs human-in-the-loop input — drag-from-port to create an edge, ⟲ Layout button click, super-user reply mid-run, approval gate decisions.

**Bugs this gap produced:**

- The Bridge pill being hidden when the bridge was off. I shipped it as "hidden when off" because I was thinking like a developer ("don't show unused UI"), not like a user ("how do I find this feature?"). A scripted user-flow run would have hit "open agents tab → look for bridge indicator → can't see it" and surfaced the issue.

### Gap 7 — Hardware/host-specific behavior

**What's blocked:** GPU detection, available VRAM, npm/Node version on host, Docker daemon up/down, whether `claude` is even on PATH, Windows-vs-POSIX path handling.

**Bugs this gap produced:**

- The `shutil.which("claude")` returning Windows paths fed to Linux containers (Gap 1, but rooted here).
- The `~/.config/codex` vs `~/.codex` cross-platform variance.

---

## What the test-validation agent needs to provide

Grouped by capability. Each capability lists the bug class it would unblock.

### Capability 1 — Sandboxed Docker runner

**Purpose:** let me run `docker build` and `docker run` against the OWLLM agent image, mount synthetic auth payloads, and capture stdout/stderr/exit.

**Requirements:**

- A Docker daemon the agent can `docker exec` into. Could be a shared dev box, a CI runner, a local Docker Desktop the user delegates to me, or a docker-in-docker setup.
- Build cache for `owllm/agent:<hash>` so I'm not rebuilding the 400 MB image every test run.
- Synthetic auth fixtures: a directory with a fake `~/.claude.json`, a fake `~/.codex/`, a fake `~/.gitconfig` shaped exactly like a real logged-in install. **No real credentials** — just structurally valid stubs that Claude Code's startup code accepts up to the point of "now make the API call". For end-to-end auth-required tests we need a separate isolated test account.
- A way to short-circuit the API call so I can test "does the in-container CLI launch, parse args, find the prompt on stdin?" without ever talking to claude.ai.

**Unblocks:** Gap 1, Gap 7 partially.

### Capability 2 — Headless GUI test harness

**Purpose:** run the OWLLM PySide6 app with `QT_QPA_PLATFORM=offscreen`, drive interactions via QTest or a script, capture screen via `QPixmap.save`, and compare layouts to expected.

**Requirements:**

- A way to launch the desktop app with a known seeded project DB (`agents/projects.py` data + `agents/bus.py` data) so I'm testing against a deterministic fixture, not whatever happens to be on disk.
- Ability to script user flows: "open agents tab → switch to graph view → click Layout button → wait 200ms → measure canvas viewport vs. items bounding rect".
- Pixel-diff or geometric assertion library: "right edge of items must be within 50 px of right edge of viewport".
- Repeatable rendering: same screen size, same font (Qt fonts vary per host), same theme.

**Unblocks:** Gap 2 (entirely), Gap 6 (mostly).

### Capability 3 — Mock-LLM agent runtime

**Purpose:** execute a real `Team.run_goal(...)` with a mock model_fn that returns scripted responses. No network, no auth, no API keys.

**Requirements:**

- A `MockBackend` that serves a deterministic conversation: given step N and message history, return the predetermined response. I'd write a small DSL: "on step 0 the orchestrator dispatches to coder; on step 1 the coder calls `read_file('foo.py')`; etc."
- The mock honors message-history truncation, tool-call parsing, multi-turn loops — exactly like a real backend would.
- Goal lifecycle plumbed end-to-end so the bus DB transitions are real even though the model is fake.
- Replay support: "I have a transcript from a past failed run, replay it through the current code and tell me whether the bug still happens."

**Unblocks:** Gap 4, Gap 5 partially.

### Capability 4 — Live state inspector

**Purpose:** when the user reports a bug in production, capture a full snapshot of the running OWLLM state and let me query it offline.

**Requirements:**

- One-shot dump of: the bus SQLite, the projects SQLite, the fleet manifest, the agent memory DB, all running OWLLM-related PIDs + their command lines, the QSettings file, the `<fleet_root>/runtime.json`, the recent `~/.owllm/` contents.
- A friendly archive format (zip with a manifest.json index) so I can inspect specific pieces without restoring the whole thing.
- Privacy filter — strip API keys, bot tokens, and the user's actual filesystem paths before anything ships off the user's machine.
- A "replay" mode: load the snapshot into a temp DB and let me run queries / re-render the canvas against it.

**Unblocks:** Gap 5 (entirely), and post-hoc analysis for any of the above.

### Capability 5 — Real-CLI integration (gated)

**Purpose:** the highest-fidelity test — actually call `claude --print` against a real Anthropic backend with a test account, inside a real container, with real auth.

**Requirements:**

- A dedicated test account (claude.ai test workspace, OpenAI test org, Telegram test bot) with usage budget separate from the user's personal accounts.
- Run only when explicitly requested ("verify against real backend") — most fixes don't need it; it's the last-mile verification.
- Strong cost guards: per-test token caps, a daily budget alert.

**Unblocks:** Gap 3 (the parts that aren't covered by the mock).

### Capability 6 — Auto-validate-on-edit

**Purpose:** when I commit a fix that claims to address a specific failure mode, automatically run the relevant subset of capabilities 1–5 and tell me whether the failure mode is gone.

**Requirements:**

- Commit-message convention or PR template: "fixes failure mode X" → maps to test bundle `tests/scenarios/X/`.
- Test bundles are versioned and checked in. Each bundle has: setup fixtures, the scripted user flow or DB seed, expected outcome, expected non-outcomes.
- Output: green/red plus a short diff. No screenshots-as-essays — I want a structured signal I can act on.

**Unblocks:** the whole "ship-then-wait" loop the user is frustrated by. With this, I can ship → validate → fix → ship in one turn.

---

## Architecture sketch

```
       ┌────────────────────┐
       │  Test-validation   │
       │       agent        │
       └────────┬───────────┘
                │
   ┌────────────┼────────────────────┐
   │            │                    │
┌──▼──┐    ┌────▼─────┐         ┌────▼─────┐
│Docker│    │PySide6   │         │ State     │
│sandbox    │offscreen │         │ snapshot  │
│(cap 1│    │harness   │         │ replay    │
│      │    │(cap 2)   │         │ (cap 4)   │
└──┬───┘    └────┬─────┘         └────┬─────┘
   │             │                    │
   └─────┬───────┴────────┬───────────┘
         │                │
    ┌────▼───────┐   ┌────▼───────┐
    │ Mock-LLM    │   │Real-CLI    │
    │ runtime     │   │integration │
    │ (cap 3)     │   │(cap 5)     │
    └─────────────┘   └────────────┘

Auto-validate-on-edit (cap 6) orchestrates above based on commit metadata.
```

The agent itself is a thin coordinator: takes a "validate this commit" or "reproduce this error from the user's logs" intent, decides which capabilities to invoke, runs them, summarizes back.

---

## Phased implementation order

Ordered by cost-to-build vs. value-unblocked:

1. **Cap 4 (state inspector)** — highest value, lowest cost. A `python -m owllm.snapshot` command that dumps the bus DB + processes + configs into a zip. Costs maybe a day. Unblocks Gap 5 entirely and gives me forensic access to every other gap as a starting point.

2. **Cap 1 (Docker sandbox)** — second highest. The OWLLM agent image already exists; I'd just need a runner that mounts synthetic auth and captures output. Maybe two days plus the synthetic-auth fixture work.

3. **Cap 3 (mock-LLM runtime)** — high value for agent-loop bugs. Could ship as a `MockBackend` in `core.agents.backends` plus a YAML format for scripted conversations. Three to four days.

4. **Cap 2 (headless GUI)** — visual bugs. Real work to get Qt-offscreen rendering deterministic. A week, probably.

5. **Cap 6 (auto-validate-on-edit)** — depends on 1-4 existing first, then it's plumbing. Maybe two days once the underlying caps are in place.

6. **Cap 5 (real CLI gated)** — lowest priority because mocks cover most cases. Add when we hit a real-only bug we can't repro otherwise.

---

## What I am explicitly NOT asking for

- A general autonomous agent that can do my job. The point is to close the **observation gap**, not to replace the human-in-the-loop on design decisions or the "is this fix actually right?" judgement call.
- Production credentials. Cap 5 is fenced for a reason.
- Browser automation against claude.ai's web UI. The CLI is enough.
- Anything that lets me run code on the user's actual machine without consent. State snapshots ship to me from their machine; I never reach into theirs.

---

## Acceptance criteria for "this agent is useful"

When the user reports a bug like the `.claude.json` one above, I should be able to:

1. Pull the user's snapshot (cap 4)
2. Reproduce the failure inside the sandbox container (cap 1)
3. Confirm my fix kills the failure in the same sandbox (cap 1)
4. Confirm the fix doesn't break anything else via the scenario suite (cap 6)
5. Ship — once.

If steps 2 and 4 are reliably possible from my current environment, the agent has done its job.

---

## Open questions

- **Sandbox host:** does the user run the validation agent on their own dev box (full fidelity, but ties their machine up), or is it a CI runner / shared box (cleaner, but needs Docker + Qt + display infra spun up)?
- **Auth fixtures:** how realistic do the synthetic `~/.claude.json` etc. need to be? Claude Code may or may not accept obvious stubs. We may need to capture a redacted real one once and reuse it.
- **Cost budget:** if cap 5 is in scope, who owns the test-account billing?
- **OWLLM main process discoverability:** for cap 4, the snapshot tool needs to know which DBs and configs to walk. We should standardize a `~/.owllm/` layout and make the snapshot tool walk that, rather than each subsystem inventing its own paths.

These are the things to settle when we sit down to build it.
