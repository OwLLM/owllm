# P0-1 · 2.5D RPG HQ — notes (engine slices shipped; art pending)

UPDATE (same day, commit 1f7814b0): the first procedural fallback
(gradient bands + raw page-icon PNGs) shipped and the user called it
miserable — correctly. Replaced with a real SVG isometric room renderer
(shaded three-face props per scene, tiled floor, glowing baseboard,
light shafts, dust, vignette) + circular ringed agent tokens with ground
shadows. Verified live at full resolution before committing. LESSON:
never ship a visual feature on logic probes alone — the pixels ARE the
done-when for anything the user looks at.

Engine completed 2026-06-13. Probes: 7 node assertions on the real
worldState + worldBus modules (XP accrual, localStorage persistence —
survives tab unmount by construction, scene choice persisted, unlock
thresholds, quest-log cap, in-order bus delivery incl. unsubscribe).
Vite build green. In-app visual pass deferred — see "probe interrupted".

## What shipped (ui/src/pages/world/ + GamifyPage)

- worldBus.ts — a TAP on the EXISTING dispatch stream (never a second
  one): AgentsPage's addActive/removeActive/appendThought/setPhase now
  also worldEmit (agent-start/agent-end/thought/run-finish). setPhase is
  wrapped (setPhaseRaw inside) so "done" emits run-finish from every
  call site at once.
- worldState.ts — module-level + localStorage progression (§0.8): xp,
  selected scene, 30-entry quest log.
- WorldPage.tsx — the Appendix-A four-layer host: background layer
  (uses /world/backgrounds/<key>.webp WHEN PRESENT, else a procedural
  mood-colored 2.5D room per scene — sky band, glow horizon, iso floor
  grid, pulsing wall panels), navmesh data (7 stations + 9 waypoints,
  normalized), sprite layer (owl PNGs from /Page_icons, CSS-transition
  walking, idle wander every ~2.8s, active glow + bob), FX/bubble layer
  (4.5s speech bubbles from thoughts, +10 XP reward pop on run-finish).
  9 scenes from A.2 with XP unlock gates (hq_loft + quest_plaza free).
  Quest board panel lists recent completed runs. GamifyPage now renders
  this instead of the Three.js stub (the plan EXPLICITLY scopes to 2.5D).

## Art: NOT generated

I cannot generate images in this session (no image tool). The A.1
prompt template + A.2 descriptions are ready in the plan; generate the
9 backgrounds (1920×1080, no text/people), save as
owllm-desktop/ui/public/world/backgrounds/<key>.webp — the page picks
them up automatically (it probes the file and falls back procedurally).
NOTE: the page loads from the WEBVIEW path /world/backgrounds/, so they
belong under ui/public/, not resources/ (adjust tauri bundling if they
should also ship outside the asset bundle).

## Probe interrupted — machine etiquette lesson

The visual click-probe collided with the USER actively working in
another window (VSCodium with a live agent session): synthetic clicks
landed in their editor (read-only areas only — verified no input typed,
no buttons hit) and an early mis-aimed click changed the OWLLM accent
to red (restored to cyan before shutdown; dev-app localStorage is a
different origin from the packaged app's, so the user's real setting
was likely never touched). RULE for future sessions: before any
synthetic clicking, check GetForegroundWindow() == target after EVERY
foreground call (the later scripts do this — keep that pattern), and
abort the whole probe if the user is interacting.

## Remaining for P0-1 done-when

- Generate + ship the 9 backgrounds (template ready).
- Live visual pass: run a real team with the Gamify tab open — ≥3
  sprites should walk to stations, bubble, and pop XP (the events are
  wired from the real loop; logic-probed end-to-end minus pixels).
- Tool-effect badges (A.4 rows 4-5) — thought events carry role; add a
  badge variant for role==="tool" when the visual pass happens.
