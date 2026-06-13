# P0-2b · Visual edge router — notes

Completed 2026-06-13. Probe: 9 node assertions on the real edgeRouter.ts
— direct blocker, 3-card wall, 6-card adversarial cluster all route with
zero edge–card intersections; same-pair edges fan out with distinct
offsets; boxed-in still returns a path.

## Shape (ui/src/pages/agentic/edgeRouter.ts — pure, no React)

Three-stage routing per edge, cheapest first:
1. The established perpendicular-port cubic (looks identical to the old
   curves when nothing blocks).
2. Lateral control-point swings: small static nudges, then DATA-DRIVEN
   candidates computed from each blocking card's lateral extent ×1.6
   (a Bezier midpoint only moves ~3/4 of its control shift — fixed-size
   nudges can never clear a wide wall).
3. Manhattan lane fallback: stub out of each port, jog to a lane fully
   outside the cluster's lateral extent, run along it, jog back. This is
   what clears tight clusters hugging the ports, where ANY single-swing
   cubic physically fails (lateral displacement tapers to zero at the
   endpoints).

Bundling: same-pair edges (direction-insensitive key) get ±16px lateral
offsets. Re-route is per-render plain computation (~30k ops worst case)
— deliberately NOT a hook, so it can never recreate the hooks-order
crash class, and dragging a card re-routes live for free.

Canvas integration (AgentsPage GraphCanvas): routed `d` replaces the raw
Bezier for both the hit-target and visible paths; ACTIVE dispatch edges
(source+target both in activeAgents — pairs with P0-2's wired dispatch)
render green with an animated marching dash (owllm-edge-flow keyframes).

## Lessons

- pathIntersectsRect handles both path shapes (cubic + polyline) — keep
  it in sync if a new path form is added.
- The probe drove the design: the 3-card wall failure exposed the
  fixed-nudge ceiling; the 6-card cluster failure exposed the
  single-swing-cubic ceiling. Geometry features NEED executable
  adversarial probes; eyeballing screenshots would have passed both.

## Remaining

- Edge labels (instruction snippet on hover) deferred to P2-1.
- Visual pass on the live canvas rides the next packaged-build session.
