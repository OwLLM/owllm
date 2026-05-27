# Supervisor Rollout Plan

How we ship the supervisor to production *fast* without breaking what works today.

## Principle

Build everything in parallel with the existing rule-based recovery, behind feature flags that default OFF. Validate with shadow-mode telemetry on real failures before flipping anything on. Cutover one failure channel at a time, smallest blast radius first.

## The single rule that makes this safe

> A PR may not break any existing test in `LLM/tests/`.

CI enforces it. The new supervisor adds tests; it does not change existing ones. If a supervisor change requires editing an existing test, it's no longer a parallel-build -- escalate before merging.

## Feature flags

Single source of truth: `core/supervisor/flags.py`. Every flag defaults safe.

| Flag | Default | Meaning |
| --- | --- | --- |
| `supervisor.enabled` | **false** | Master switch. While false, supervisor module is fully inert. |
| `supervisor.shadow_mode` | **true** | When master is on, supervisor only observes -- no actions. |
| `supervisor.runtime_failures` | false | Allow supervisor to act on runtime probe failures. |
| `supervisor.training_failures` | false | Allow supervisor to act on training crashes. |
| `supervisor.dataset_failures` | false | Allow supervisor to act on dataset format errors. |
| `supervisor.install_failures` | false | Allow supervisor to act on install step failures. |
| `supervisor.auto_apply_safe` | false | Auto-apply `safe`-tier actions; otherwise UI confirm. |
| `bootstrap.use_ai_installer` | false | Use bootstrap.exe for new installs vs. classic installer. |

`supervisor_active(channel)` returns True iff: master on AND shadow off AND `supervisor.<channel>_failures` on. Use this as the single boolean gate.

Flags file location:
- Windows: `%LOCALAPPDATA%/OWLLM/feature_flags.json`
- Other:   `~/.config/owllm/feature_flags.json`

Missing file = all defaults (production-safe).

## Phases

| # | Name | Duration | What's enabled | Ship criterion |
| --- | --- | --- | --- | --- |
| 0 | **Build** | done | nothing user-visible | scaffold lands; existing tests still pass -- **complete** |
| 1 | **Shadow (internal)** | 2-4 weeks | `enabled=true, shadow_mode=true` for devs only | weekly review of `shadow_log.jsonl`; supervisor agreement with rules ranked |
| 2 | **Shadow (beta)** | 2-4 weeks | same flags, opted-in beta channel | enough data: 500+ real failure events across hardware variety |
| 3 | **Read-only fixes** | 1-2 weeks | `auto_apply_safe=true` for read-only tools (`read_log`, `pip_show`, `probe_hardware`) | no regression in install/training success rates |
| 4 | **Gated writes (one channel)** | 2-4 weeks | `supervisor.runtime_failures=true`, `shadow_mode=false`, UI toast confirms each fix | user-accept rate >= 70% AND fix-success rate >= 85% on runtime channel |
| 5 | **Gated writes (all channels)** | 4 weeks | training, dataset, install channels enabled one at a time | same thresholds per channel |
| 6 | **AI installer beta** | 4-6 weeks | `OWLLM-Setup-AI.exe` published as opt-in second installer | install success rate >= classic installer |
| 7 | **Default cutover** | release | `bootstrap.use_ai_installer=true` becomes the new install default | only after Phase 6 hits parity |

Phases 1-2 are the longest because **they generate the data** that decides whether the model is ready. Skipping them means we're flying blind.

## What ships first (this week's commit)

The smallest unit that unblocks everything else: the **shadow logger**.

Already landed:
- `core/supervisor/flags.py` -- flag reader with safe defaults.
- `core/supervisor/shadow.py` -- `observe(channel, trigger, rules_decision)` that writes to `~/.owllm/shadow_log.jsonl` only when both flags are on. Never raises.
- `core/supervisor/brain.py` -- HTTP client for the bundled llama-server. `ensure_running()` (idempotent spawn + health poll), `diagnose(trigger) -> Plan`, `shutdown_idle()` (5-min RAM reclaim). Fully testable via injected http/spawn/clock seams. Returns `ask_user` fallback Plan on every failure path -- never raises.
- `tests/test_supervisor_*.py` -- 66 tests pinning production-safety contracts (flags, shadow, brain, page, toast, corpus pipeline). All offline.

Pending (not yet wired):
- `core/runtime/self_heal_orchestrator.py` will get a `shadow.observe()` call in its repair entrypoint as the first wire-in. Validated locally; staged for a follow-up PR once the file's pending WIP changes land.
- training, dataset, install, mcp wire-ins follow same pattern.

UI:
- `desktop_app/pages/supervisor_page.py` -- live shadow log table + flag state panel. Auto-refreshes every 3s.
- `desktop_app/widgets/supervisor_toast.py` -- non-modal "Apply fix?" confirmation widget for Phase-3+ proposals. Three trust tiers (safe/confirm/danger) with countdown auto-skip. 9 tests pinning the timeout-never-applies safety contract.
- `tools/demo_supervisor_toast.py` -- standalone manual harness so devs can eyeball the toast layout without booting the full app.
- `desktop_app/main.py` -- adds the Supervisor tab to MainWindow ONLY when `supervisor.enabled` is true. Production users never see this tab.

Runtime artifacts:
- `bootstrap/runtime/download_runtime.py` -- fetches `llama-server` + `gemma-4-E2B-it-Q4_K_M.gguf` from configurable URLs (defaults: llama.cpp GitHub releases, Hugging Face Unsloth mirror). Run once on a dev machine before flipping the master switch.

Bootstrap (install-time):
- `bootstrap/bootstrap_go/` -- Go native install-time launcher. Compiles to `bootstrap.exe` (Windows) via `go build -ldflags "-H=windowsgui"`. Components: hardware probe (nvidia-smi/wmic), llama-server lifecycle (spawn/health/shutdown with hidden console), tolerant plan parser, action executors. **All 8 actions are now real**: `create_venv`, `install_pkg`, `download_file`, `pick_profile` (with inline expansion + recursion guard), `swap_wheel`, `set_env`, `ask_user`, `uninstall_pkg`. ~40 Go unit tests covering parser + every executor with injected fakes (no real subprocess, no real HTTP, no real LLM).
- `bootstrap/installer/OWLLM-Setup-AI.nsi` -- NSIS installer source, per-user install layout under `%LOCALAPPDATA%\OWLLM\bootstrap\`. Auto-launches `bootstrap.exe` at end-of-install so the supervisor immediately drives the Python venv setup.
- `bootstrap/build_installer.bat` -- one-shot orchestrator: `download_runtime.py` -> `go build` -> `makensis`. Produces `OWLLM-Setup-AI.exe` ready to ship as the Phase-6 parallel installer flavor.

Net effect on production users today: **zero behavioral change.** Master switch is false; the new code is dead code in every prod install.

To start collecting data on a dev machine:

```powershell
$flags = "$env:LOCALAPPDATA\OWLLM\feature_flags.json"
New-Item -ItemType Directory -Force -Path (Split-Path $flags) | Out-Null
Set-Content $flags '{ "supervisor.enabled": true, "supervisor.shadow_mode": true }'
```

Then use OWLLM normally. Every runtime probe failure now leaves a row in `%LOCALAPPDATA%\OWLLM\shadow_log.jsonl`. After a week of normal use, run the corpus pipeline:

```powershell
python LLM\tools\build_failure_corpus.py
python LLM\tools\structure_failure_corpus.py     # claude-haiku
python LLM\tools\review_failure_corpus.py
```

The output graduates into the fine-tune corpus.

## Wire-in checklist (one site at a time)

For each existing failure path we want under shadow observation:

1. Find the existing rule-based decision point.
2. Add `from core.supervisor import shadow` -- imported lazily inside the function to keep startup unaffected.
3. Wrap the `shadow.observe(...)` call in `try/except: pass` (belt-and-braces; shadow already swallows internally).
4. Verify all existing tests for that file still pass.
5. Add one new test asserting that `shadow.observe` is *called* with sensible args when the path triggers (using `monkeypatch.setattr(shadow, "observe", spy)`).

Order of wire-in (least -> most invasive):
- [x] `core/runtime/self_heal_orchestrator.py::try_repair_probe_failure` -- runtime channel
- [ ] `core/training.py` failure handlers -- training channel
- [ ] `desktop_app/training_widgets.py` dataset validator -- dataset channel
- [ ] `installer_v2.py` step failures -- install channel
- [ ] `desktop_app/mcp/server_manager.py` mcp crash handler -- mcp channel

## Rollback

Every phase has a one-line rollback: edit the user's `feature_flags.json` (or remove it) and the supervisor returns to inert. No code redeploy needed. The classic installer keeps shipping; the AI installer is a separate `.exe` we can pull from the download page in minutes.

## What we are NOT doing

- We are NOT replacing `profile_selector.py`, `capability_matrix.py`, or the rule-based body of `self_heal_orchestrator.py` until shadow data shows the supervisor matches them on real failures.
- We are NOT shipping a single big-bang `OWLLM-Setup.exe` rewrite. The new bootstrap is a parallel installer flavor first.
- We are NOT removing any rules until the supervisor has been *defaulted on* for that channel for at least one full release cycle and the rule has been visibly unused (zero invocations in telemetry).

## Open production-readiness items

- llama-server.exe + bundled Gemma 4 E2B GGUF: still TBD. Phases 3+ require the model to be runnable locally.
- Bootstrap.exe (Go binary): still TBD. Required for Phase 6.
- Telemetry uploader (opt-in, redacted): TBD. Required to scale past internal-dev shadow data.
- UI: `desktop_app/pages/supervisor_page.py` showing live shadow log and a "Apply fix?" toast widget. Required for Phase 4.

These are the next building blocks to schedule. Each is a separate PR; none of them block the shadow logger from shipping today.
