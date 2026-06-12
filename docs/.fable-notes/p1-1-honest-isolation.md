# P1-1 · Honest isolation status — notes

Completed 2026-06-13. Probe: bundled the real `isolationBadge.ts` with
esbuild and executed 5 assertions in node — including the done-when case
(host path + isolation requested → "⚠ HOST — NOT isolated", loud red).
Vite build green; the 3 pre-existing AgentsPage tsc errors are unchanged
(line numbers shifted only).

## Design decision that matters

The badge derives from `isWslPath(cwd)` — the SAME predicate the Rust shell
router uses to decide isolation (`sandbox::shell_argv` → `parse_wsl_unc`).
It is path-truth, not a setting or a cached probe, so it CANNOT drift from
what actually happens at execution time. "Forcing a sandbox failure flips
the badge" holds by construction: a fallback always produces a host cwd.

Three states in `ui/src/pages/agentic/isolationBadge.ts`:
- isolated (green) — cwd inside the sandbox
- hostFallback (LOUD red, "⚠ HOST — NOT isolated") — isolation requested
  but this cwd runs on the host. The P1-1 state.
- host (amber) — isolation off; write-jail + command guard only.

## Where the silent fallbacks were

- `chat_scratch_dir` (agent_tools.rs:166-179): isolation on + WSL fails →
  silently returns a HOST scratch dir. Left the Rust fallback in place
  (graceful degradation is wanted) — the ChatPage badge now exposes it.
- AgentsPage had NO OS-isolation badge at all (its "Sandboxed" badge is
  trust_writes — the write-jail toggle, a different axis). LocationRow now
  shows the isolation badge next to it, fed by location-path truth.
- CodePage's badge existed and was truthful but never distinguished
  "you asked for isolation and didn't get it" — now uses the shared helper.

## Lessons

- AgentsPage "Sandboxed / Direct writes" badge ≠ isolation. trust_writes is
  the write-jail axis; OS isolation is the cwd-path axis. Keep them visually
  adjacent but separate — merging them would lie in both directions.
- Probing UI logic without a test runner: `npx esbuild <module> --bundle
  --platform=node` + node assertions works fine even when the module's
  import chain touches @tauri-apps/api (nothing calls invoke at import
  time). Repo has NO vitest/jest — don't write .test.tsx files.
- ChatPage held the scratch dir in a ref only; badges need state. Kept the
  ref (used as cwd at dispatch time) and added state alongside.

## Remaining risks / follow-ups

- Linux/macOS isolated projects (~/owllm host paths) read as "host" to
  isWslPath — the badge under-reports isolation on those OSes. Acceptable
  until P0-7/P4-1 (Lima/bwrap parity); revisit `is_under_iso_root` parity
  in the frontend then.
- The fine-tuning TRAIN run itself (finetuning.rs) always runs in WSL or
  fails loudly — no silent fallback there (verified by reading
  build_trainer_command; it errors when best_linux_distro is None).
