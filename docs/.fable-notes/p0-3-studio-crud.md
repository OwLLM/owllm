# P0-3 · Studio editing (team/agent CRUD) — notes

Completed 2026-06-13. Probes: `probe_studio_crud_roundtrip` (ignored test,
runs against the REAL custom dirs with unique names + self-cleanup) —
team create → list → edit-by-same-stem → delete, built-in-shadowing
refused, outside-path delete refused, agent create → collision refused →
delete. Plus sanitize_stem unit tests; 42/42 lib tests green; vite build
green. UI flow click-probed only via build (the packaged smoke covers the
Watcher; a Studio visual pass rides the next release smoke).

## What was there vs what was added

agents.rs already had the READ layer (list_team_templates /
list_agent_roles incl. custom dirs) and save_agent_definition (edit an
existing custom agent). The Studio UI had all the CRUD buttons — wired to
`alert("…lands in the next slice… edit the JSON manually…")` stubs.

Added Rust: save_team_template (stem-sanitized, refuses built-in names,
enforces data.name == stem so the UI never predicts sanitization),
delete_team_template, create_agent_definition (refuses built-in role ids
+ existing customs), delete_agent_definition — all with the same
canonicalized-path containment guard as save_agent_definition.

Added UI: TeamEditorDialog (create-from-scratch with an orchestrator+
specialist starter roster, or edit-a-custom — display/category/
description + agent rows with base-role dropdowns and extra prompts;
PATCHES a clone of the raw JSON so unknown fields like mcp_pack/graph/
icon survive), real duplicate/delete handlers for teams and agents,
new-agent skeleton creation. Every mutation fires vault_sync_teams
(fire-and-forget) so customs ride the vault.

## Lessons

- StudioPage's mapped Team/AgentDef shapes DROP unknown JSON fields by
  design — CRUD needs the raw backend records (kept in refs keyed by the
  UI name). Never rebuild a template from the mapped shape.
- Skills (SKILL.md packs) are NOT roles: duplicate synthesizes a role
  JSON from the visible fields; delete routes to the Skill Library
  (their files are managed there).
- Race hazard discovered: build-release.bat was still compiling while I
  edited agents.rs — the resulting exe was indeterminate. Don't edit
  Rust while a release build runs; UI-only edits are fine (vite already
  ran by then). Wait or rebuild after.

## Remaining risks / follow-ups

- The editor is form-based (P0-3 scope); the drag-drop builder + tool
  wiring panel is P2-2.
- Editing a custom team does not rename its stem (display name changes,
  id stays) — fine, ids are stable, but surface it in UI copy if users
  ask.
- graph_json/edges aren't editable here yet — that pairs with P0-2
  (edges drive dispatch) and the AgentsPage canvas.
