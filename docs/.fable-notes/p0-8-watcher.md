# P0-8 · The Watcher — notes (Slices 1+2 shipped)

Slices 1 (summon + drawer) and 2 (support_snapshot) completed 2026-06-13.
Probe: REAL app run (`npx tauri dev`), Win32 synthesized clicks, screenshots
read back — the drawer opened from the top-center summon and "Check my
setup" rendered the live snapshot (OWLLM 0.4.75, Ryzen 5950X/32GB, RTX
4090, WSL Ubuntu·mc, env ready, llama.cpp found). Screenshots in
%TEMP%\owllm_watcher_probe*.png during the session.

## CRITICAL discovery: two chrome modes, two summon points

`overlay_frame_enabled()` defaults TRUE → on this machine (and likely all
users) the chrome is the OVERLAY FRAME window ("OwLLM Overlay Frame"), a
separate click-through webview (`set_ignore_cursor_events(true)`), and
AppShell renders OverlayContentPanel — the React HybridFrame (and its owl
badge) NEVER RENDERS in this mode. Wiring only the HybridFrame owl would
have shipped a dead feature.

- HybridFrame mode: the owl badge img is the summon (pointerEvents flips
  to auto only when the callback is wired).
- Overlay mode: the centered OWLLM title in the ModeBar (directly beneath
  the click-through owl) is the summon. Tooltip carries the name. Making
  it clickable removes a 200×54px patch from the header drag region —
  accepted tradeoff.
- The once-per-minute "The Watcher" satellite label animates next to
  whichever summon is live; stops forever after first open
  (localStorage owllm:watcher:discovered).

## Architecture

- `support.rs::support_snapshot` COMPOSES existing probes (readiness::
  app_readiness, hardware_info, server_status via app.state::<ServerState>,
  wsl_setup_status, module_list) — no parallel diagnostics. Non-secret by
  construction.
- `ui/src/support/WatcherDrawer.tsx` — drawer with chat-style entries +
  actions: What page am I on? (PAGE_BLURBS map), Check my setup (snapshot
  render + "Home page has a Set-up button" nudge on ❌ rows), Report a bug
  (stub honest about shipping later).

## Probe technique (reusable for any UI verification)

tauri dev in background → EnumWindows by process id (FindWindow by title
was flaky; enumerate instead) → SetForegroundWindow → SetCursorPos +
mouse_event → CopyFromScreen → Read the PNG. Remember: PowerShell tool
calls do NOT share Add-Type state — redefine the P/Invoke class per call.
First click may be eaten by whatever modal is open (AccountSyncModal) —
screenshot first, then aim.

## Also noted

- tauri.conf.json currently has `transparent: false` + the overlay-frame
  split. The old "transparent:true non-negotiable" memory refers to the
  HybridFrame era; the overlay window itself is transparent:true. DON'T
  touch either.

## Remaining slices

- Slice 3: app-window screenshot (PrintWindow incl. modals) — the probe
  technique above is half the implementation.
- Slice 4: local activity counters.
- Slice 5: model choice + AI diagnosis (reuse ModelPicker discovery; tiny
  Gemma <1GB fallback offer).
- Slice 6: send report (private path default, preview + consent, redaction).
