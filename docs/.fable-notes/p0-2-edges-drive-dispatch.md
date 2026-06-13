# P0-2 · Edges drive dispatch — notes

Completed 2026-06-13. Probe: 10 node assertions against the real
dispatch.ts — the exact done-when (same dispatch text, edge toggled →
opposite outcomes), distinct "not wired" wording, roster matches outgoing
edges, no-edges teams keep free dispatch.

## Shape

- `wiredDispatchTargets(team, orch)` → Set of edge-wired targets, or
  null when the team has NO edges (legacy free dispatch — existing
  projects unchanged). Edges are {source, target}; only edges FROM the
  orchestrator grant dispatch rights.
- Both loops (runDispatchLoop + AgentsPage, §0.4) filter parsed
  dispatches through the wired set AFTER the P1-3 unresolved handling:
  unwired-but-real names surface as amber "NOT WIRED — draw the edge"
  thoughts (deliberately distinct from P1-3's red "no such agent"), and
  when the graph blocks EVERYTHING, one correction round feeds
  `unwiredCorrectionMessage` (wired roster named; empty roster → "answer
  the user yourself") back to the orchestrator.
- Edge-seeded roster: both buildOrchestratorPrompt copies show only the
  wired specialists when a graph exists — the drawn graph defines who is
  reachable, so the model rarely even tries an unwired name.
- The synthetic critical_thinker stays available regardless (it is not
  in team.agents and routes through its own channel).

## Semantics decision

A team WITH edges but none leaving the orchestrator = the orchestrator
can dispatch nobody (it is told to answer solo and say why). That is the
spec's "the graph is real" reading; only a fully edge-less team falls
back to free dispatch.

## Remaining

- The end-to-end UI probe (toggle an edge on the canvas, run, watch the
  amber notice) rides the next packaged-build session; the policy layer
  + both wiring points are probed/compile-verified.
- P0-2b (visual router) builds on this: route + highlight the edges that
  actually fired.
