# OWLLM — Master Build Plan (brief for Claude Fable 5)

> **Who this is for:** an autonomous Claude Fable 5 coding agent executing the OWLLM
> roadmap on this repo. Read §0 (operating rules) and §1 (how to work) **before**
> touching code. Then pick a work-package from §2–§6 in priority order. Each package
> is self-contained: Goal · Files · Approach · Done-when (probe) · Guardrails.
>
> This plan is the full up-front spec. Fable does best with the whole goal stated at
> once and run at high effort — so the packages are detailed on purpose. Don't try to
> do everything in one pass; complete one package, verify it, commit, move on.

---

## 0. Operating rules — non-negotiable repo facts

These come from `CLAUDE.md` and hard-won history. Violating them has wasted days before.

1. **The live app is `owllm-desktop/`** (Tauri Rust + React). Everything runtime is here:
   UI `owllm-desktop/ui/src/`, Rust `owllm-desktop/src-tauri/src/`.
2. **`python-app/_legacy/` and `python-app/core/agents/` are DEAD.** Do not debug runtime
   from them, do not cite them, do not "fix" them. If you find `<tool_call name=...>` XML,
   `parse_tool_calls`, or `format_for_prompt`, you are in the corpse — back out.
3. **Tool-calling is NATIVE GGUF ONLY.** Chat + agentic both send the OpenAI `tools` array to
   `llama-server --jinja` and read structured `delta.tool_calls`. There is **no** XML catalog
   and no dialect parsing. Never reintroduce one. The shared local loop is `streamLocalChat()`
   in `owllm-desktop/ui/src/pages/agentic/dispatch.ts`; tool specs are in
   `owllm-desktop/ui/src/pages/agentic/localTools.ts`.
4. **There are TWO cloud-dispatch copies that must change together:**
   `owllm-desktop/ui/src/pages/agentic/dispatch.ts` AND its duplicate inside
   `owllm-desktop/ui/src/pages/agentic/AgentsPage.tsx`. Fixing one and not the other caused the
   "works in Code, fails in Agents" bug. Grep both for any dispatch change.
5. **WSL detection discipline** (this class of bug has recurred ~5×): after an app upgrade/reboot
   the WSL service is cold and the first `wsl.exe` calls return empty/error — that is TRANSIENT,
   not "WSL absent". Always (a) distinguish transient-empty (retry w/ backoff) from definitive-none
   (spawn-fail or stderr "no installed distribution", decoded via `decode_wsl` for UTF-16LE);
   (b) resolve the distro through `crate::wsl::best_linux_distro()` — never the raw default (often
   `docker-desktop` busybox: no bash/realpath/wslpath); (c) parse WSL output behind sentinels
   (`OWLLM_LINUX=` / `OWLLM_UNC=`), never by line position (MOTD banners corrupt line 1).
   Files: `src-tauri/src/wsl.rs`, `wsl_setup.rs`, `env_manager.rs`, `readiness.rs`.
6. **Window must stay `transparent:true`** (`tauri.conf.json`) — opaque mode destroys the
   HybridFrame cutaway. White-flash fix is reveal-on-load (`visible:false` + `on_page_load` show),
   not paint-after-the-fact.
7. **Secrets NEVER sync.** Provider API keys/CLI logins stay device-local (Rust accounts store /
   DPAPI), never in the GitHub vault or localStorage.
8. **Page state must persist outside components** — OWLLM pages unmount on tab switch. Use
   `chatRuntime` / `useChatSession` + `setPayload`, not bare `useState`, or navigating away blanks
   the page.
9. **Build for everyone, not the dev's 4090.** Design and verify against the whole GPU/OS matrix
   (Turing→Blackwell, Windows/WSL/Linux/macOS). Don't pin defaults to one machine.

### Build / verify / ship loop
- **Build:** local default `owllm-desktop/build-release.bat`, **run it via the PowerShell tool**
  (`cmd /c "C:\1_Git\LocaLLM\owllm-desktop\build-release.bat"`) — Git Bash mangles the `/c` flag.
  TS-only change → delete `src-tauri/target/x86_64-pc-windows-gnu/release/owllm-desktop.exe` first
  or cargo skips the relink and ships stale UI.
- **Verify with a probe, never "build succeeded."** Win32/HTTP/curl smoke-test the actual behavior
  before declaring done. The user has been burned by false "done" repeatedly.
- **Sign** from git-bash (key-as-content + empty-password env + `< /dev/null`); **publish**
  end-to-end to the `OwLLM/owllm` Latest release without making the user click. Source repo is
  `ruigro/LLM-Studio`.
- **Commit = commit + push.** The user verifies on GitHub's web UI. Audit `git status` first and
  stage files explicitly — never sweep pre-existing dirty files into a build.

---

## 1. How to work this plan (Fable 5 operating guidance)

- **Run at `high`/`xhigh` effort.** This is long-horizon agentic work; give each package the full
  context up front, then execute.
- **Delegate to async sub-agents** for independent fan-out (e.g. "audit every MCP schema", "probe
  WSL on 3 distros", "map all dispatch call-sites"). Keep working while they run; don't spawn-and-block.
- **Keep a memory file** at `docs/.fable-notes/<package>.md`: one lesson per file, why it mattered,
  corrections and confirmed approaches. Consult it before re-touching an area. Don't duplicate what
  the repo/git already records.
- **Ground every progress claim against a tool result.** If a probe didn't run, say so; don't report
  "fixed" off one clean run (the model-warmup and WSL bugs are intermittent).
- **No unrequested tidying.** A bug fix doesn't need surrounding refactors; don't add abstractions,
  feature flags, or error handling for impossible cases. Validate only at real boundaries.
- **Boundaries:** when the user is describing a problem, the deliverable is your assessment — don't
  apply a fix until asked. Within a chosen package, proceed autonomously on reversible steps.
- **One package = one PR-sized unit.** Finish → probe → commit+push → update the memory note → next.

---

## 2. MUST FINISH (P0 — core promises, currently stub or broken)

### P0-1 · 2.5D RPG HQ (NOT full 3D)
**Goal:** a charming **2.5D / isometric RPG headquarters**: small animated agent icons walking around
rooms, speech bubbles, tool-use effects, a quest board, and XP / unlocks / rewards. The **background is
static art**; all life comes from the overlay layer (agent sprites, bubbles, glows, badges, particles,
state changes). This is deliberately scoped *down* from full 3D — it's more achievable and more charming.
See **Appendix A** for the complete art direction, the 9 background scenes, the generation prompt
template, and the render-layer architecture. Build to that spec.
**Files:** new under `owllm-desktop/ui/src/pages/world/` (scene host, sprite layer, bubble layer, FX
layer, navmesh); background art under `owllm-desktop/resources/world/backgrounds/` (or `icons/world/`);
agent/team data from `owllm-desktop/resources/agents/`; bind to the existing agentic event stream.
**Approach — ship in slices, not one mega-feature:**
- **Slice 1 — static scene + scene picker.** Render one of the 9 full-HD backgrounds (Appendix A) with a
  scene selector. Background is a single `<img>`/canvas layer scaled to fit; UI overlays sit above it.
- **Slice 2 — agents on a navmesh.** Render the current team as small agent icons placed on per-scene
  **walk lanes / waypoints** (a hand-authored navmesh per background — the art leaves open floor for
  exactly this). Idle wander between waypoints.
- **Slice 3 — bind to a live run.** Subscribe to the **existing** agentic dispatch event stream (do NOT
  fork a parallel one): on task-start an agent walks to its station; on tool-call play a tool effect +
  badge; thoughts/replies show as speech bubbles; on finish, a reward pop. ≥3 agents visibly animate.
- **Slice 4 — quest board + XP/unlocks.** Tasks become quests on a board; completing them grants XP that
  unlocks scenes/cosmetics. Persist via `chatRuntime`/localStorage (per §0.8) so it survives tab switch.
**Done-when:** a real agentic run visibly moves ≥3 agent icons station→tool→finish with bubbles + a tool
effect over a chosen background, the scene picker switches among the 9, and XP/unlocks survive a tab
switch (probe: run a team, switch tab and back, assert state + unlocks intact).
**Guardrails:** §0.6 (the world layer must respect `transparent:true` / HybridFrame — composite over the
existing UI, don't replace the window surface), §0.8 (persistence). Keep it 60fps with a dozen agents;
sprites + CSS/canvas, no heavy 3D engine. Subscribe to existing dispatch events — never a second stream.

### P0-2 · Edges drive dispatch (make the graph REAL) — **do this before the router**
**Goal:** the arrows between agent cards must actually constrain/drive execution, not just decorate.
**Verified current state (2026-06-13):** edges are **purely cosmetic.** They're stored in `graph_json`
and read only for visual layering (`computeDepths()`, `dispatch.ts:355`). The dispatch loop
(`runDispatchLoop`, ~`dispatch.ts:2057`) **never reads `team.edges`** — execution is 100% driven by the
orchestrator's free-text `@agent:` lines (`parseDispatches`, `dispatch.ts:736-755`). Drawing an arrow
changes nothing at runtime. **A prettier router over cosmetic edges is polishing a decoration — so this
package lands first.**
**Files:** `dispatch.ts` (`runDispatchLoop`, `parseDispatches`, `buildOrchestratorPrompt` ~566-673, the
`Team`/`Edge` types ~354) **and the duplicate dispatch in `AgentsPage.tsx`** (§0.4 — both copies);
edge storage `graph_json` in `AgentsPage.tsx` (~288-303).
**Approach — edges as an execution graph, not a picture:**
- **Allow-list constraint (minimum):** an orchestrator `@agent:` dispatch is only honored if an edge
  `orchestrator → agent` exists in `team.edges`. If the orchestrator names an agent with no incoming
  edge, **don't silently drop it** (today's bug, `dispatch.ts:750`) — surface a clear "not wired"
  notice and feed it back to the orchestrator so it can correct. This alone makes the graph meaningful.
- **Edge-seeded roster (recommended):** `buildOrchestratorPrompt` should derive "YOUR SPECIALISTS" from
  the orchestrator's **outgoing edges**, not the whole team — so the drawn graph defines who's reachable.
- **Optional ordering/chaining:** support non-orchestrator edges (`A → B`) as "B receives A's output",
  enabling simple pipelines the orchestrator doesn't have to micro-manage. Keep this behind the
  allow-list work; don't block the minimum on it.
- **Round-trip:** editing the graph (once P0-3 lands the editor) re-persists `graph_json` and changes
  behavior on the next run.
**Done-when:** with an edge removed, the orchestrator naming that agent yields a visible "not wired"
message and the specialist does NOT run; with the edge present it runs; the orchestrator's specialist
list matches its outgoing edges (probe: toggle one edge, run the same prompt, assert opposite outcomes).
Verify from **both** dispatch paths (§0.4).
**Guardrails:** §0.4 (two copies). Don't break solo/no-graph teams — when a team has no edges, fall back
to today's free-dispatch behavior so existing projects keep working.

### P0-2b · Agent-graph edge ROUTER (visual) — after P0-2
**Goal:** now that edges mean something, make them *look* right: replace naive SVG curves with a real
router — obstacle avoidance around live draggable cards, no overlaps, clean bundling, selected-path
highlight, edge labels, animated flow (animate along **active** dispatch edges during a run).
**Files:** the Agents-page graph render (in/near `AgentsPage.tsx`); consider a dedicated
`ui/src/pages/agentic/edgeRouter.ts`.
**Approach:** model cards as obstacles; compute orthogonal (Manhattan) or routed-Bezier paths with
collision detection; bundle parallel edges; recompute on drag. Evaluate a proven lib (elkjs / dagre
for layout, or a lightweight orthogonal router) before hand-rolling — but the cards are *user-draggable*,
so layout must be incremental, not full re-layout on every frame.
**Done-when:** with 6+ cards arranged adversarially, no edge crosses a card body, parallel edges bundle,
dragging a card re-routes smoothly, and an active dispatch animates along its edge (probe: scripted drag,
assert no edge–card intersection; run a team, assert the fired edge highlights).
**Guardrails:** keep it 60fps on drag; debounce re-route.

### P0-3 · Studio editing (team/agent CRUD)
**Goal:** create, duplicate, delete, edit full team templates and custom agents **in-app** — no more
buttons that explain manual JSON.
**Files:** team templates `owllm-desktop/resources/agents/teams/*.json`, roles
`resources/agents/roles/*.yaml`; Studio UI in the agentic pages; custom dirs referenced by `vaultSync`
(`custom_teams_dir` / `custom_agents_dir`).
**Approach:** a builder panel: drag agents into a team, wire tools, edit role/persona, save as a new
template, duplicate a built-in, version it. Persist to the custom dirs (which already sync via
`vault_sync_teams`). Replace every "edit the JSON manually" affordance with a real form.
**Done-when:** user creates a team from scratch, duplicates a built-in, edits an agent, deletes a custom
team — all without opening a file; changes round-trip through sync (probe: create on device A semantics
via the vault path).
**Guardrails:** built-ins are read-only templates — duplicate-to-edit, never mutate the shipped JSON.

### P0-4 · Auto model routing
**Goal:** remove the explicit "not implemented yet" path; auto-pick a model per task instead of forcing
the user to choose.
**Files:** `dispatch.ts` `providerFor` / model-selection; the `auto/` prefix branch already stubbed;
`ModelPicker.tsx`.
**Approach:** define a routing policy (task kind → tier): cheap/local for simple, mid for tool-use,
high-tier cloud for hard reasoning; honor availability (local server up? keys present? CLI warm?).
Surface an "Auto" entry that resolves at dispatch time and shows what it picked. Apply in **both**
dispatch copies (§0.4).
**Done-when:** selecting "Auto" runs end-to-end choosing different models for a trivial vs a hard prompt,
and the UI reports the resolved model (probe both Code and Agents pages).
**Guardrails:** never silently route to a paid cloud model without the cost being visible.

### P0-5 · Isolation reliability (WSL path hardening)
**Goal:** make the strong path (WSL) dependable end-to-end: install, distro choice, Ubuntu user setup,
login sync, project conversion, toolchain provisioning, and honest fallback-to-host.
**Files:** `src-tauri/src/wsl.rs`, `wsl_setup.rs`, `env_manager.rs`, `readiness.rs`, `sandbox.rs`,
`overlay_frame.rs`; UI `WslSetupModal.tsx`, `readinessStore.ts`.
**Approach:** apply §0.5 everywhere; finish the in-app WSL setup wizard (user+password auto-create with
DPAPI at-rest); make project conversion sentinel-parsed; provision toolchains idempotently. Self-heal
readiness on cold start (HomePage already force-rechecks — extend the discipline).
**Done-when:** on a freshly-upgraded machine with a docker-desktop default distro, detection is correct,
project creation works, and env provisioning succeeds (probe on a cold box, not a warm dev one).
**Guardrails:** §0.5. See §3-1 for the honesty requirement when isolation falls back to host.

### P0-6 · Fine-tuning environment "doctor"
**Goal:** make the most breakable feature diagnosable and repairable: CUDA / torch / bitsandbytes /
Unsloth / venv / model-format failures detected precisely with one-click repair.
**Files:** `src-tauri/src/env_manager.rs`, bundled `resources/finetune.py`, `convert_hf_to_gguf.py`;
env UI `EnvironmentModal.tsx`.
**Approach:** a doctor that runs targeted probes (python present? uv present? torch importable? CUDA arch
matches GPU? bitsandbytes kernels for this arch? Unsloth/torch version compatibility?) and maps each
failure to a fix. **Make version pins adapt to detected hardware** — pinned torch 2.5.1 locks out
Blackwell/RTX 50xx (§0.9). Gate detection on `uv` (it fetches its own managed Python), per prior fixes.
**Done-when:** a deliberately broken env (wrong torch for the GPU arch) is identified by name and repaired
in one click (probe: break it, run doctor, confirm fix).
**Guardrails:** environment-specific workarounds expire — re-validate, don't assume.

### P0-7 · Linux/macOS standalone runtime
**Goal:** finish model-serving runtime variants. Linux as a full agent+serving box; macOS Metal runtime
+ GPU detection.
**Files:** `src-tauri/src/` hardware/server management; bundled runtime under `resources/runtime/`;
`build-release.bat` + CI for the other targets.
**Approach:** build a cross-platform runtime catalogue (P3-5): per-OS llama.cpp/serving bundles, GPU
detection (CUDA on Linux, Metal on macOS). Linux already builds as an app — add the serving bundle.
**Done-when:** a local model serves and answers on Linux and on macOS (Metal), each with correct GPU
detection (probe: a real completion on each OS).
**Guardrails:** §0.9 matrix; GPU selection via UUID (`get_chosen_gpu_index`, PCI_BUS_ID), never raw index.

### P0-8 · The Watcher — in-app AI Support Assistant + Bug Reporter
**Goal:** add a global animated support assistant, **The Watcher**, summoned from the unlabeled owl icon
in the HybridFrame top-center. The Watcher understands what is happening in the app, helps the user in
plain language, and can package a high-quality bug report for the OWLLM team. This is not a generic
chatbot: it is an app-aware support agent with access to the current page, visible UI state, recent user
activity, diagnostics, logs, environment status, model/server status, and an optional full-window
screenshot that includes app popups/dialogs.
**Files:** global entry point in `owllm-desktop/ui/src/AppShell.tsx`; new UI under
`owllm-desktop/ui/src/pages/support/` or `ui/src/support/`; Rust diagnostics commands under
`owllm-desktop/src-tauri/src/support.rs` or `diagnostics.rs`; reuse existing probes from
`readiness.rs`, `wsl.rs`, `env_manager.rs`, `server.rs`, `modules.rs`, `accounts.rs` status checks
without duplicating them.
**Approach — ship in slices:**
- **Slice 1 — Watcher summon.** The top-center owl icon in the HybridFrame becomes the support entry
  point. Keep it unlabeled by default, but once per minute a small animated satellite label orbit/slide
  around it with the text **"The Watcher"** to suggest the click without cluttering the chrome. After
  the user opens The Watcher once, stop the periodic label by default (keep a subtle hover tooltip).
  Clicking the owl opens an animated Watcher drawer/modal with assistant chat, "What page am I on?",
  "Check my setup", and "Report a bug" actions.
- **Slice 2 — app context snapshot.** Build a local `support_snapshot` command that returns: app version,
  OS, GPU/hardware snapshot, selected page, current model/server status, WSL/sandbox status, fine-tuning
  env status, installed modules, recent non-secret errors/log lines, and current project/team ids/names.
- **Slice 3 — screenshot capture.** Implement a user-approved "Capture current app" button. It must
  capture the actual app window including in-app modals/popups. If OS-level window capture is unavailable
  on a platform, fall back to a WebView/DOM screenshot and say what was not captured. Never capture other
  monitors/windows without an explicit warning. Note: `screenshot_url.py` captures web URLs, not the app
  window; app-window capture is a new platform path (Windows: Win32 window capture such as PrintWindow /
  BitBlt where appropriate; macOS/Linux need their own implementations or explicit fallback messaging).
  The "compose existing probes" rule applies to diagnostics, not to this new screenshot subsystem.
- **Slice 4 — activity statistics.** Keep local-only rolling counters: pages visited, feature attempts,
  failed actions, model loads, env installs, bridge starts, tool-call failures, time-to-error. Store only
  product telemetry, not prompt contents, file contents, API keys, tokens, paths with secrets, or personal
  messages. Let the user view/clear it.
- **Slice 5 — model choice + AI diagnosis.** The Watcher can choose among the user's available local
  models, API keys, and subscription CLIs (Claude/Codex/Gemini/Kimi/etc.) using the same model/provider
  discovery as the rest of the app. Prefer a cheap/local model for ordinary support questions, escalate
  only when needed, and show the selected model/provider before cloud use. If the user has no usable
  model, offer to download a very small recommended support model (target: **Gemma 4-class / under 1 GB**
  GGUF when available in the catalogue) so the Watcher can run locally. The assistant reads the snapshot +
  optional screenshot + user description and produces: likely cause, immediate fix steps, whether this
  looks like a product bug, and the minimum repro steps.
- **Slice 6 — send report.** Add "Send to OWLLM" that posts a redacted report bundle to the chosen
  backend. Default to a **private** path (private endpoint, private repository issue, private email inbox,
  or local export file). A public GitHub issue is a privacy footgun and must be explicit opt-in with a
  warning that screenshots/logs may reveal user data. The report should include screenshot attachment,
  structured diagnostics JSON, app logs, user-written description, assistant summary, repro steps,
  severity, and release/version. If no private backend is configured, save an export bundle locally.
**Done-when:** from any page, the top-center owl summons The Watcher; the animated "The Watcher"
satellite label appears periodically without disturbing the frame; "Capture current app" captures a
modal-over-app state; the assistant chooses an available model/subscription or offers the tiny Gemma
fallback when none exists; it summarizes a real broken-env or failed-model-load state; "Send report"
creates a redacted bundle with screenshot + diagnostics + repro; user can preview exactly what will be
sent before sending.
**Guardrails:** §0.7 is absolute: secrets never leave the device. This feature is allowed to egress
non-secret diagnostics only because the user explicitly approves, redaction runs first, and the full
bundle is previewed before sending. Bug reports require explicit user approval and a preview. Redact API
keys, tokens, auth files, local home paths when possible, prompt/file contents by default, and screenshots
if the user cancels. Never auto-send diagnostics. Do not build a parallel diagnostics system — compose
the existing status/probe commands.

---

## 3. BUGGY / FRAGILE — stabilize (P1)

### P1-1 · Honest isolation status
When isolation fails and the app keeps running on host guardrails, the user **must know they are no
longer isolated**. Add a prominent, truthful status badge (isolated vs host-fallback) wherever a
sandboxed action runs. Files: `sandbox.rs`, dispatch UI. Done-when: forcing a sandbox failure visibly
flips the badge to "host — NOT isolated".

### P1-2 · Credential mirroring into sandbox
Host accounts / CLI logins / API keys / GitHub token / `gh` / Codex·Claude·Gemini·Kimi each have storage
quirks. Make mirroring deterministic and observable (what got mirrored, what didn't, why). Files:
`vault.rs` (`github_connect`, `sandbox_sync_logins`), `accounts.rs`. **Respect the classifier limits**:
do not copy real credential files (`auth.json`) into WSL or scrape the signing key — those are forbidden
and must not be worked around. Done-when: a sync report lists each credential's mirror status.

### P1-3 · Robust agent-dispatch parsing
The orchestrator must emit exact `@agent: task` lines or specialists don't run. **Verified failure modes
(2026-06-13):** `parseDispatches` (`dispatch.ts:736-755`) matches `@name: task` but (a) is
**case-sensitive** — `@Coder` ≠ `coder` — and (b) **silently drops** any name not in the team
(`if (!known.has(name)) continue;`, `dispatch.ts:750`) with **zero feedback to the model**, so a
near-miss name = specialist never runs and nobody knows. Make the parser tolerant (case-insensitive +
fuzzy-match to the nearest team member, whitespace, fenced blocks) and **fail loud**: when a line names
no resolvable agent, feed a correction back to the orchestrator ("no agent 'Coder' — did you mean
'coder'?") instead of dropping it. Pairs with P0-2's allow-list (an unwired-but-real name should warn,
not vanish). Apply in **both** dispatch copies (§0.4). Files: `parseDispatches` + `runDispatchLoop` in
`dispatch.ts` and the duplicate in `AgentsPage.tsx`. Done-when: 5 malformed-but-recoverable variants
(case, extra punctuation, fuzzy name) still dispatch; a truly unresolvable one surfaces a clear,
model-visible error and the run doesn't silently under-deliver.

### P1-4 · Model warmup / broken GGUF / GPU OOM legibility
First local call when `llama-server` is cold, or an incompatible GGUF, or OOM still feels mysterious.
Use a real readiness signal (llama-server `/health`, already available — don't sleep), and map cold /
incompatible-format / OOM to distinct, actionable errors. Files: server management Rust + local dispatch.
Done-when: each of the three conditions yields a distinct message (probe: trigger each).

### P1-5 · MCP schema sanitization
One malformed MCP server can poison native tool-calling. Sanitize/validate every MCP tool schema before
it enters the `tools` array; quarantine a bad server with a clear notice instead of breaking all
tool-calling. Files: `localTools.ts` (MCP tool assembly). Cross-ref the open probe in memory
(`agentic_tool_calling_probe`): test by disabling MCP and re-running. Done-when: a deliberately malformed
MCP server is quarantined and the other tools still work.

### P1-6 · Bridges reliability (Telegram/WhatsApp/Discord/Slack/email)
Each brings tokens, tunnels, permissions, provider-specific delivery failures, sync state. Harden the
shared core (`useBridgeDispatch()` owns dispatch; bridges supply only a transport) with per-provider
delivery-failure surfacing and reconnect. Files: bridge architecture per `project_bridge_architecture`.
Done-when: a token/tunnel failure on one bridge shows a specific actionable error and doesn't wedge the
others.

---

## 4. WISH TO DO (P2)

- **P2-1 Real edge router** — superset of P0-2b: obstacle avoidance, Manhattan/Bezier, edge labels,
  collision detection, animated flow, selected-path highlight. (Fold into P0-2b if done well there.)
- **P2-2 Full team builder** — superset of P0-3: drag agents, wire tools, save/duplicate/version
  templates.
- **P2-3 Plain-language git-worktree conflict resolver** — for multi-agent concurrent worktrees;
  explain conflicts in prose and offer guided resolution. Ties to `project_fleet_architecture`.
- **P2-4 Environment doctor++** — superset of P0-6: pinpoint *exactly* why training/env/model-load
  failed, one-click repair.
- **P2-5 Cross-platform runtime catalogue** — superset of P0-7: Linux/macOS serving bundles as a
  managed, updatable catalogue (keep model-handling layer post-ship updatable, per
  `project_post_ship_model_updates` — no .exe rebuild to refresh).
- **P2-6 Real Home readiness panel** — actual per-OS Python, torch, CUDA, WSL, llama.cpp, MCP, and env
  status (not a cached guess). Extend `readinessStore`; session-cache but refresh-on-demand.

## 5. SUPER COOL TO HAVE (P3, after P0/P1 solid)

- **P3-1 Full 2.5D HQ (mature)** — the polished ceiling of P0-1: all 9 scenes live, per-agent character
  animation sets, project map, mission board, rich tool-use animations, scene transitions, cosmetics
  shop. Same 2.5D approach as P0-1 — do **not** escalate to full 3D.
- **P3-2 "The team is working" mode** — watch agents move through tasks, pass artifacts, argue with the
  critic, merge results. Drives directly off the real agentic event stream.
- **P3-3 Model-vs-model arena** — scoring, prompt sets, leaderboards, fine-tuned-model comparison. Reuse
  the shared ModelPicker + `list_models`; persist results.
- **P3-4 Voice personalities per agent** — live speech + interruption; persona-driven (pairs with the
  Studio persona data).
- **P3-5 Agent replay / timeline** — inspect every thought, tool call, file edit, decision, merge. The
  dispatch already streams thoughts/tool deltas — record and make them seekable.
- **P3-6 "OwLLM builds OwLLM" loop** — agents propose features, implement, test, visually inspect, open
  PRs. (This very plan is its backlog.)

## 6. TOO DIFFICULT BUT WORTH IT (P4 — long-horizon bets)

- **P4-1 True secure isolation everywhere** — not just Windows/WSL: Lima/bwrap parity per
  `project_sandbox_isolation_model`. Honesty (P1-1) is the interim.
- **P4-2 Beautiful pathfinding around live draggable cards** — the polished ceiling of P0-2b/P2-1.
- **P4-3 Reliable local fine-tuning across consumer GPUs** — the hardware-adaptive pins of P0-6 taken to
  the whole matrix.
- **P4-4 Native GGUF tool-calling across many model families** — current bet is the native template
  (§0.3); push coverage. Keep the layer post-ship updatable (data, not .exe).
- **P4-5 Multi-agent concurrency** — separate worktrees, merge safety, understandable recovery
  (`project_fleet_architecture` substrate exists: manifest + broker).
- **P4-6 Cross-machine split** — GPU model server on one box, isolated agents elsewhere. The vault +
  `vault_publish_server` / remote-GPU + SSH agent tools are the seed; polish hard. One of the app's
  strongest ideas.

---

## 7. Suggested execution order

P0-5 + P0-6 (isolation/env reliability — they block everything else and bleed user trust)
→ P1-1…P1-5 (stop the bleeding on fragile paths)
→ P0-8 (Support Assistant + bug reporter — so future failures come back with screenshots, logs, and repro)
→ P0-3 (Studio CRUD — unblocks team authoring) → P0-4 (auto routing)
→ P0-2 (edges drive dispatch — make the graph real) → P0-2b (visual router) → P0-1 (2.5D RPG HQ slices — see Appendix A)
→ P0-7 + P2-5/P2-6 (cross-platform runtime + real readiness)
→ P3 showcase features → P4 long-horizon bets.

Do **not** start a P3 showcase before P0/P1 in the same area is solid — a flashy HQ over a broken event
stream or unreliable isolation just makes the cracks prettier.

---

## Appendix A — 2.5D RPG HQ: art direction, backgrounds, render architecture

This is the build spec for P0-1 / P3-1. The principle: **the background is static art; the life comes
from animated agent icons, speech bubbles, glows, badges, particles, and state changes.** That split is
what makes this achievable and charming without a 3D engine.

### A.0 Shared art direction (applies to all 9 backgrounds)
Comic-book 2.5D / isometric-ish background, **rich ink outlines**, cozy sci-fi workstation mood, readable
rooms, dramatic but not too dark, deliberate empty space for UI overlays. **Hard constraints, every
image:**
- **1920×1080** exactly (full HD, 16:9).
- **No text, no logos, no UI, no watermarks** baked in.
- **No characters / no people** baked in — live agents render as a separate sprite layer on top.
- **Open floor / clear walk lanes** through the scene for small animated agent icons, plus clean
  foreground + center space for agent icons and speech bubbles.
- Layered depth (fore/mid/back) so the sprite layer can sit convincingly *in* the room.
- Deliver as PNG (lossless master) + an optimized WebP for runtime. Keep masters out of the bundle if
  size is a concern; ship WebP.

### A.1 The generation prompt template
Generate each scene by filling `[ENVIRONMENT DESCRIPTION]` into this exact template:

> "Full HD 1920x1080 comic-book 2.5D isometric background for a desktop AI app.
> Scene: **[ENVIRONMENT DESCRIPTION]**.
> Rich ink outlines, cozy futuristic workstation style, layered depth, readable open floor paths for
> small animated characters, dramatic lighting, polished game UI background, no text, no logos, no
> people, no characters, leave clean foreground and center space for animated agent icons and speech
> bubbles."

### A.2 The 9 scenes (and the app surface each one skins)
Each scene doubles as a themed backdrop for an existing app surface, so the HQ isn't a separate toy — it
*is* the workspace. File naming: `resources/world/backgrounds/<key>.webp`.

| # | key | `[ENVIRONMENT DESCRIPTION]` | Skins / default for |
|---|---|---|---|
| 1 | `hq_loft` | A warm open-plan command loft with glowing desks, wall screens, mission boards, cozy lamps, cables, and separate work pods | **Home / default HQ scene** |
| 2 | `server_core` | A futuristic server room with GPU towers, blue-green data streams, cooling pipes, holographic model graphs, and a central inference engine platform | Server / local-serving page |
| 3 | `finetune_workshop` | A lab/workshop hybrid with dataset crates, training monitors, whiteboards, tool benches, calibration devices, and a glowing "model forge" area | Fine-tuning / env doctor (P0-6) |
| 4 | `sandbox_bunker` | A secure Linux isolation bunker: reinforced glass rooms, terminal stations, locked vault doors, hazard stripes, clean secure zones, and a visible boundary between safe/unsafe areas | Isolation / sandbox (pairs w/ P1-1 honest-status) |
| 5 | `research_library` | A magical technical archive: tall shelves, floating documents, research desks, web-search portals, pinned notes, and evidence boards | Research / critic teams |
| 6 | `debug_office` | A noir-comic debugging room with case boards, red string, terminal monitors, bug evidence folders, magnifying-glass desk lamps, and suspicious broken code fragments | Debugging / code teams |
| 7 | `bridge_control` | A communications hub for Telegram, Discord, email, Slack, WhatsApp: radio consoles, message tubes, signal towers, inbox panels, and glowing connection lines | Bridges page (P1-6) |
| 8 | `arena_coliseum` | A playful model-vs-model arena with two response platforms, audience screens, score lights, comparison podiums, and a dramatic central prompt stage | Model arena (P3-3) |
| 9 | `quest_plaza` | A cozy RPG mission plaza with a quest board, reward chest, upgrade shop, small team houses, lanterns, paths between stations, and room for agents to walk around | Quest board / XP / unlocks hub |

Scenes are **selectable** (scene picker) and some unlock via XP (P0-1 Slice 4). `quest_plaza` and
`hq_loft` ship unlocked; the rest can gate behind progress or just be free — designer's call.

### A.3 Render-layer architecture
Four stacked layers inside `ui/src/pages/world/`, composited over the existing UI (respect §0.6 — do not
take over the window surface):

1. **Background layer** — one static image, scaled `cover` to the viewport, never animated.
2. **Navmesh (data, not drawn)** — per scene, a hand-authored set of **waypoints + walk lanes + agent
   stations**, authored against that background's open floor. Store as JSON next to the art
   (`<key>.navmesh.json`): `{ stations: {agentRole: [x,y]}, waypoints: [...], lanes: [[a,b],...] }`.
   Coordinates normalized 0–1 so they scale with the 1920×1080 art.
3. **Agent sprite layer** — one small icon per live agent (reuse/adapt the owl art in
   `icons/Page_icons/`). Agents pathfind along the navmesh between stations; idle = gentle wander.
4. **FX + bubble layer** — speech bubbles (thoughts/replies), tool-use effects, glows, state badges,
   reward particles. Pure CSS/canvas; no physics engine.

### A.4 Event → animation mapping (bind to the EXISTING dispatch stream)
Subscribe to the same agentic event stream the Agents page already emits (§0.4 — never a second stream).
Map events to overlay behavior:

| Dispatch event | HQ reaction |
|---|---|
| agent/task start | sprite walks from idle to its **station**; "active" glow on |
| thought delta (🧠) | small thought bubble (…); optional summarized text |
| reply/text delta | speech bubble with the line |
| tool-call start | tool effect at the sprite (e.g. spark/icon) + tool badge |
| tool result | badge resolves ✓/✗; brief particle |
| sub-agent spawn | a second sprite peels off / walks in |
| task finish | reward pop, XP tick, sprite returns to wander |
| error / refusal | sprite shows a distress badge; no fake "done" (ties to P1-3/P1-4 legibility) |

### A.5 Progression (Slice 4)
- **Quests** = tasks/runs surfaced on the `quest_plaza` board.
- **XP** accrues on completion; thresholds **unlock** scenes (the gated backgrounds above) and cosmetics.
- Persist the whole progression object via `chatRuntime`/localStorage (§0.8) so it survives tab unmount
  and (optionally, later) syncs through the vault like other non-secret state.

### A.6 Asset checklist for Fable
- [ ] Generate 9 backgrounds via the A.1 template + A.2 descriptions; verify each is 1920×1080, no
      text/logos/characters, with usable open floor.
- [ ] Optimize to WebP; place in `resources/world/backgrounds/`; bundle in `tauri.conf.json` resources.
- [ ] Author a `<key>.navmesh.json` per scene (stations/waypoints/lanes), normalized coords.
- [ ] Build the four-layer host; bind to the existing dispatch event stream; implement the A.4 mapping.
- [ ] Probe: run a real team over `hq_loft`, confirm ≥3 agents move station→tool→finish with bubbles +
      a tool effect, switch scenes, and confirm XP/unlocks survive a tab switch.
