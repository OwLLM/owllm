# P1-3 · Robust agent-dispatch parsing — notes

Completed 2026-06-13. Probe: bundled the REAL dispatch.ts with esbuild and
executed 12 assertions in node — all 5 done-when recoverable variants
(case, whitespace, trailing punctuation, fuzzy 'codr', markdown bold)
dispatch correctly; unresolvable names land in `unresolved` with a
suggestion; fuzzy never over-reaches ('designer' does NOT match 'coder');
self-dispatch and critical_thinker exclusions intact.

## Shape

- `parseDispatchesDetailed(text, team, exclude)` in dispatch.ts returns
  `{ dispatches, unresolved }`. Resolution ladder: exact → case-insensitive
  → normalized (strip `[\s._-]`) → Levenshtein ≤ 2 AND ≤ half the target
  name (the half-rule is what stops cross-matches).
- `unresolvedCorrectionMessage()` builds the model-visible correction
  ("@reviewer:" names no agent… team is exactly: …, re-emit now).
- Both loops (runDispatchLoop in dispatch.ts AND AgentsPage's duplicate)
  surface every unresolved line as a red thought, and when unresolved
  lines cost ALL dispatches, run ONE correction round feeding the message
  back to the orchestrator, then re-parse. Bounded at one retry.
- **Killed the duplicate parser**: AgentsPage now imports the parser from
  dispatch.ts via a structural `TeamLike = { agents: {name}[] }` param
  (the two pages have different nominal `Team` types — structural typing
  sidesteps that). One less §0.4 copy to keep in sync. The dispatch LOOPS
  are still duplicated — only the parser is unified.

## Lessons

- The two Team types (dispatch.ts vs AgentsPage) are nominal near-twins;
  any future shared helper should take structural params, not `Team`.
- esbuild probes: don't pass `--external:@tauri-apps/*` — node can't
  resolve it at runtime; just let esbuild inline it (importing
  @tauri-apps/api/core has no side effects at module load).
- 'reviewer' → no suggestion (distance to 'researcher' > 3): the
  correction message therefore ALWAYS includes the exact roster, so a
  missing suggestion never strands the model.

## Remaining risks

- The correction retry runs only when unresolved lines cost ALL
  dispatches. Partial under-delivery (2 of 3 lines resolved) surfaces red
  thoughts + the integration prompt sees fewer replies, but no retry —
  deliberate, to avoid doubling latency on mostly-good plans.
- P0-2 (edges drive dispatch) will add the "real name but not wired"
  case to this same unresolved/warn path — keep the wording distinct
  ("not wired" vs "no such agent").
